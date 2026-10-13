import { Endpoints } from "./const.js";
import { Spotify } from "./client.js";
import { SelfUser } from "./types.js";
import { parseSelfUser } from "./parser.js";
import { SpotifyApiError, SpotifyError } from "./errors.js";

export class UserClient {
    readonly client: Spotify;

    constructor(client: Spotify) {
        this.client = client;
    }

    public async me(): Promise<SelfUser> {
        const [account, profile] = await Promise.all([
            this.attributes("accountAttributes"), this.attributes("profileAttributes")
        ]);
        return parseSelfUser({account, profile});
    }

    public async isPremium(): Promise<boolean> {
        if (this.client.options.forcePremium) return true;
        const account = await this.attributes("accountAttributes");
        return account.product.toLowerCase() === "premium";
    } 

    private async attributes(operation: "accountAttributes" | "profileAttributes"): Promise<any> {
        let hash = await this.client.playlists.queryHash(false, operation);
        const body = () => ({operationName: operation, variables: {},
            extensions: {persistedQuery: {version: 1, sha256Hash: hash}}});
        let response: any;
        try {response = await this.client.request(Endpoints.QUERY, body());}
        catch (error) {
            if (!(error instanceof SpotifyApiError && error.statusCode === 412)) throw error;
            response = {errors: [{message: "PersistedQueryNotFound"}]};
        }
        if (response?.errors?.some((error: any) => error.message === "PersistedQueryNotFound")) {
            hash = await this.client.playlists.queryHash(true, operation);
            response = await this.client.request(Endpoints.QUERY, body());
        }
        if (response?.errors?.length) throw new SpotifyError("Spotify could not read account metadata");
        const value = response?.data?.me?.[operation === "accountAttributes" ? "account" : "profile"];
        if (!value || (operation === "accountAttributes" &&
            (typeof value.product !== "string" || !["free", "premium", "open"].includes(value.product.toLowerCase()))) ||
            (operation === "profileAttributes" && typeof value.username !== "string"))
            throw new SpotifyError("Invalid Spotify account metadata response");
        return value;
    }
}
