import { createHmac } from "node:crypto";
import undici from "undici";

import { Endpoints } from "./const.js";
import { SpotifyError } from "./errors.js";

export const getSpotifyTotp = async () => {
    const codesUrl = "https://git.gay/thereallo/totp-secrets/raw/branch/main/secrets/secrets.json"; // totp secrets source
    const codes: any = await undici.request(codesUrl, {headers: {"User-Agent": "node-spdl/1.0.0"}, headersTimeout: 15000, bodyTimeout: 15000})
        .then(async (r) => {
            if (r.statusCode !== 200) {await r.body.dump(); throw new SpotifyError("Spotify login is temporarily unavailable");}
            return r.body.json();
        });

    const seeds = Array.isArray(codes) ? codes : codes.secrets;
    const latest = Array.isArray(seeds) ? seeds.reduce((newest, entry) =>
        Number.isInteger(entry?.version) && (!newest || entry.version > newest.version) ? entry : newest, undefined) : undefined;
    if (!latest || typeof latest.secret !== "string" || !latest.secret.length || latest.secret.length > 1000 || latest.version <= 0 ||
        (!Array.isArray(codes) && !(Date.parse(codes.validUntil) > Date.now()))) {
        throw new SpotifyError("Spotify login is temporarily unavailable");
    }
    const sauce: string = latest.secret;
    const version: number = latest.version;

    const secretSauce = Array.from(Buffer.from(sauce, "ascii"))
        .map((n, i) => n ^ ((i % 33) + 9))
        .map((n) => n.toString())
        .join("");

    const secretBytes: string[] = [];
    Buffer.from(secretSauce, "utf8")
        .forEach((n) => secretBytes.push(n.toString(16)));

    const secret = Buffer.from(secretBytes.join(""), "hex")

    const period = 30;
    const digits = 6;

    const response: any = await undici.request(Endpoints.SERVER_TIME, {headersTimeout: 15000, bodyTimeout: 15000})
        .then((r) => r.body.json());
    const timestamp = response["serverTime"];
    if (!Number.isFinite(timestamp) || Math.abs(timestamp * 1000 - Date.now()) > 300000)
        throw new SpotifyError("Spotify login is temporarily unavailable");
    const counter = Math.floor(timestamp / period);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));

    const hmac = createHmac("sha1", secret)
        .update(counterBuffer)
        .digest();
    const offset = hmac[hmac.length - 1] & 0x0f;

    const binary =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);

    const otp = (binary % 10 ** digits).toString().padStart(digits, "0");
    return { otp, version }
} 
