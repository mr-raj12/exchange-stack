import type {
  Depth,
  Fill,
} from "../types/common-types";
import { randomUUID } from "crypto";

export interface getUserBalanceReturnType {
  balance: Record<string, number>;
  locked: Record<string, number>;
}
export interface unlockRequestType {
  userId: string;
  asset: string;
  amount: number;
}
export class BalanceStore {
  // userId->asset->amount
  private balance = new Map<string, Map<string, number>>();
  private locked = new Map<string, Map<string, number>>();

  public getLocked(userId: string) {
    let m =this.locked.get(userId);
    if(!m){
      m= new Map<string,number>();
      this.locked.set(userId,m);
    }
    return m;
  }
  public getBalance(userId: string) {
    let m =this.balance.get(userId);
    if(!m){
      m= new Map<string,number>();
      this.balance.set(userId,m);
    }
    return m;
  }

  public unlock(userId: string, asset: string, amount: number): void {
    // is userId k balance m asset ka amount badha do
    const currentLocked = this.locked.get(userId);
    const currentBalance = this.balance.get(userId);
    const currentLockedAmount = currentLocked?.get(asset) || 0;
    if (currentLockedAmount < amount) {
      throw new Error("locked balance is less than amount to unlock");
    }
    currentLocked?.set(asset, currentLockedAmount - amount);
    currentBalance?.set(asset, (currentBalance.get(asset) || 0) + amount);
    // is userId k locked m asset ka amount ghatado
  }
  public lock(userId: string, asset: string, amount: number): void {
    // is userId k balance m asset ka amount badha do
    const currentBalance = this.balance.get(userId);
    let currentLocked = this.locked.get(userId);
    const currentBalanceAmount = currentBalance?.get(asset) || 0;
    if (currentBalanceAmount < amount) {
      throw new Error("balance is less than amount to lock");
    }
    if (!currentLocked) {
      this.locked.set(userId, new Map<string, number>());
      currentLocked = this.locked.get(userId);
    }
    currentLocked?.set(asset, (currentLocked.get(asset) || 0) + amount);
    currentBalance?.set(asset, currentBalanceAmount - amount);
  }
  public deductLocked(userId: string, asset: string, amount: number): void {
    const m = this.locked.get(userId);
    const currentLockedAmount = m?.get(asset) || 0;
    if (currentLockedAmount < amount) {
      throw new Error("locked balance is less than amount to deduct");
    }
    m?.set(asset, currentLockedAmount - amount);
  }
  public credit(userId: string, asset: string, amount: number): void {
    let m = this.balance.get(userId);
    if (!m) {
      this.balance.set(userId, new Map<string, number>());
      m = this.balance.get(userId);
    }
    const currentBalanceAmount = m?.get(asset) || 0;
    m?.set(asset, currentBalanceAmount + amount);
  }

  getUserBalance(userId: string): getUserBalanceReturnType {
    let b1 = this.balance.get(userId);
    let l1 = this.locked.get(userId);
    if (!b1) {
      b1 = new Map<string, number>();
      this.balance.set(userId,b1);
    }
    if (!l1) {
      l1 = new Map<string, number>();
      this.locked.set(userId,l1);
    }
    const ans = {
      balance: Object.fromEntries(b1),
      locked: Object.fromEntries(l1),
    };
    // return m;  as map is not serializable(bcoz => ) we need to convert it to object
    return ans;
  }
  getUserBalanceOnly(userId: string): Record<string, number> {
    let m = this.balance.get(userId);
    if (!m) {
      m = new Map<string, number>();
      this.balance.set(userId, m);
    }
    // return m;  as map is not serializable(bcoz => ) we need to convert it to object
    return Object.fromEntries(m);
  }
  getUserLockedOnly(userId: string): Record<string, number> {
    let m = this.locked.get(userId);
    if (!m) {
      m = new Map<string, number>();
      this.locked.set(userId, m);
    }
    // return m;  as map is not serializable(bcoz => ) we need to convert it to object
    return Object.fromEntries(m);
  }

  // Serialize all balances to a plain JSON-safe object for snapshotting.
  serialize(): Record<string, { balance: Record<string, number>; locked: Record<string, number> }> {
    const out: Record<string, { balance: Record<string, number>; locked: Record<string, number> }> = {};
    for (const [userId, balMap] of this.balance) {
      out[userId] = {
        balance: Object.fromEntries(balMap),
        locked: Object.fromEntries(this.locked.get(userId) ?? new Map()),
      };
    }
    return out;
  }

  // Rebuild all balance Maps from a snapshot object.
  restoreFromSnapshot(data: Record<string, { balance: Record<string, number>; locked: Record<string, number> }>): void {
    this.balance.clear();
    this.locked.clear();
    for (const [userId, { balance, locked }] of Object.entries(data)) {
      this.balance.set(userId, new Map(Object.entries(balance).map(([a, v]) => [a, Number(v)])));
      this.locked.set(userId, new Map(Object.entries(locked).map(([a, v]) => [a, Number(v)])));
    }
  }

  // Directly set a specific asset balance for a user — used during WAL replay.
  walSetBalance(userId: string, asset: string, available: number, locked: number): void {
    let bal = this.balance.get(userId);
    if (!bal) { bal = new Map(); this.balance.set(userId, bal); }
    bal.set(asset, available);
    let lck = this.locked.get(userId);
    if (!lck) { lck = new Map(); this.locked.set(userId, lck); }
    lck.set(asset, locked);
  }
  //   deposit(userId: string, asset: string, amount: number): unknown {
  //     if (!ExchangeStore.ASSETS.has(asset)) {
  //       throw new Error("invalid asset");
  //     }
  //     const currentBalance =
  //       this.balance.get(userId) || new Map<string, number>();
  //     currentBalance.set(asset, (currentBalance.get(asset) || 0) + amount);
  //     this.balance.set(userId, currentBalance);
  //     if (!this.locked.get(userId)) {
  //       this.locked.set(userId, new Map<string, number>());
  //     }
  //     return this.getUserBalance(userId);
  //   }
}

export const balanceStore = new BalanceStore();
