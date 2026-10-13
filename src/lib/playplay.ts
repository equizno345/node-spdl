import undici from "undici";

import { Spotify } from "./client.js";
import { Endpoints, AudioType } from "./const.js";
import { SpotifyApiError, SpotifyAuthError } from "./errors.js";
import { PlayPlayLicenseRequest, PlayPlayLicenseResponse } from "./proto.js";

export class PlayPlayClient {
    readonly client: Spotify;

    constructor(client: Spotify) {
        this.client = client;
    }

    public async getKey(fileId: string, licenseType: AudioType) {
        const provider = this.client.options.unplayplay;
        if (!provider || !(provider.token instanceof Uint8Array) || !provider.token.length || typeof provider.deobfuscateKey !== "function")
            throw new SpotifyAuthError("A valid PlayPlay provider must be configured.");
        const licensePayload = PlayPlayLicenseRequest.encode({
            version: 2,
            token: provider.token,
            interactivity: 1,
            contentType: licenseType,
            timestamp: Math.floor(Date.now() / 1000)
        });

        const license = await this.getLicense(licensePayload.finish(), fileId);
        let obfuscatedKey: Buffer;
        try {
            const challenge = PlayPlayLicenseResponse.decode(license) as any;
            obfuscatedKey = Buffer.from(challenge.obfuscatedKey || []);
        } catch {
            throw new SpotifyAuthError("Invalid PlayPlay license response.");
        }
        if (!obfuscatedKey.length) {
            throw new SpotifyAuthError("No PlayPlay key was provided by the response.");
        }

        const key = await provider.deobfuscateKey(
            Buffer.from(fileId, "hex"),
            obfuscatedKey
        );

        if (!(key instanceof Uint8Array) || key.length !== 16)
            throw new SpotifyAuthError("The PlayPlay provider returned an invalid audio key.");
        return Buffer.from(key);
    }

    private async getLicense(
        challenge: Uint8Array,
        fileId: string,
    ): Promise<Buffer> {
        const request = await undici.request(
            `${Endpoints.PLAYPLAY}${fileId}`,
            {
                method: "POST",
                body: challenge,
                headers: this.client.getRawHeaders(),
                headersTimeout: 15000,
                bodyTimeout: 15000
            }
        );

        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request.body) {
            length += chunk.length;
            if (length > 64 * 1024) {
                request.body.destroy();
                throw new SpotifyAuthError("PlayPlay license response exceeded the size limit.");
            }
            chunks.push(Buffer.from(chunk));
        }
        const content = Buffer.concat(chunks);
        if (request.statusCode !== 200) {
            // Observed error responses encode an opaque provider code in field 1.
            // Preserve it without guessing token validity or account entitlement.
            const providerCode = content.length === 2 && content[0] === 8 && content[1] < 128 ? content[1] : undefined;
            const retryAfter = request.headers["retry-after"];
            throw new SpotifyApiError(request.statusCode,
                `Spotify PlayPlay license request failed${providerCode === undefined ? "" : ` (provider code ${providerCode})`}`,
                typeof retryAfter === "string" ? retryAfter : undefined, providerCode);
        }
        return content;
    }
}
