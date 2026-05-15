declare global { // opens the global namespace
    namespace Express { // in express' namespace
        interface Request { // redeclare Request interface
            userId?: string;
        }
    }
}


export {}; // makes file a module (else declare global syntax is invalid)

// req.userId = string | underfined