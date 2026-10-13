import { SpotifyResolveError } from "./errors.js";

export const validateURL = (url: string): boolean => {
    const urlRegex = /^https?:\/\/(?:open\.spotify\.com\/(?:track|playlist|album|artist|episode|show|user)|spoti\.fi\/)/;
    return urlRegex.test(url); 
}

export const getIdFromURL = (url: string): string | null => {
    const trackRegex = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:track|playlist|album|artist|episode|show|user)\/([a-zA-Z0-9]+)\/?(?:\?.*)?$/;
    const match = url.match(trackRegex);

    return match ? match[1] : null;
}

export const getIdFromQuery = (query: string) => {
    let id: string | null = null;
    if (validateURL(query)) {
        const queryId = getIdFromURL(query);
        if (queryId) {
            id = queryId;
        }
    } else {
        id = query.match(/^spotify:(?:track|playlist|album|artist|episode|show|user):([a-zA-Z0-9]+)$/)?.[1] || query;
    }

    if (!id) {
        throw new SpotifyResolveError("query", "An invalid Spotify URL was provided.");
    }

    return id;
}
