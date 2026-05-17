quantized to fractional trades for qty

The fix would be to use the order book to estimate:


// lock only what's needed for this quantity at worst case price
const worstAsk = opposites[opposites.length - 1]?.price ?? 0;
lockAmount = worstAsk * quantity;

data structure optimization
ioc immediate or cancel remainder (fill what available)
fok (fill complete or reject entire no partial)

do not u think on engine startup we should make initilaize things like for every userID of user that exists in table we should initilaize balances of all kinds of quotes to null as of now(later on snapshot thing will be done) then also things like all markets that exising in exchanges store we should initialize and emprty order boook for them
i guessthis should not be done willl order fills map  
locked m bhi nhi kuch to  iinilaly nothing locked init krde?

Agar kabhi multiple engine instances chalao — tab do alag machines pe alice aur bob ka order same time pe process ho sakta hai, tab timestamp chahiye hoga. Abhi ke liye tumhara single consumer loop naturally FIFO guarantee karta hai.


smallest unit precision

strongly types jaha schema ya jaha type ya interface ka jarurat ho wo retrunr kre 