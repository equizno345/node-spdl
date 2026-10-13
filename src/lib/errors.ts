export class SpotifyError extends Error { 
    constructor(
        message: string
    ) {
        super();
        this.message = `Spotify Error: ${message}`;
    }
}

export class SpotifyApiError extends Error { 
    constructor(
        public readonly statusCode: number,
        message: string,
        public readonly retryAfter?: string,
        public readonly providerCode?: number
    ) {
        super();
        this.message = `Request failed with code ${statusCode || "unknown"} (${message})`;
    }
}

export class SpotifyAuthError extends Error { 
    constructor(
        message: string
    ) {
        super();
        this.message = `Spotify Auth failed: ${message}`;
    }
}

export class SpotifyResolveError extends Error { 
    constructor(
        obj: string,
        reason: string
    ) {
        super();
        this.message = `Could not resolve ${obj}: ${reason}`;
    }
}

export class SpotifyStreamError extends Error { 
    constructor(
        reason: string
    ) {
        super();
        this.message = reason;
    }
}
