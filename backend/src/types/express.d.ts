declare global { // opens the global namespace
    namespace Express { // in express' namespace
        interface Request { // redeclare Request interface
            userId?: string;
            queue?: "SPOT" | "PERPS"; // optional property that can be either "SPOT" or "PERPS"
        }
    }
}


export {}; // makes file a module (else declare global syntax is invalid)

// req.userId = string | undefined, means if it exists then must be a string 