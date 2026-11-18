// A certificate made at each test run (8c-2b plan, question 12 (a)): a fresh EC key, and the X.509 certificate's bytes
// written here and signed with Node's own crypto, so no private key is ever committed. Self-signed, for one DNS name.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

const len = (n: number) => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag, ...len(body.length)]), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
const oid = (text: string) => {
  const [a, b, ...rest] = text.split(".").map(Number) as [number, number, ...number[]];
  const bytes = [40 * a + b];
  for (const n of rest) {
    const sevens = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) sevens.unshift((v & 0x7f) | 0x80);
    bytes.push(...sevens);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const time = (d: Date) => tlv(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, "")}Z`));
const ECDSA_SHA256 = "1.2.840.10045.4.3.2";

// A key and its certificate in PEM, for `name`, good from an hour before now until a day after.
export function certificate(name: string): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const named = seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(name)))));
  const now = Date.now();
  const extensions = tlv(
    0xa3,
    seq(
      seq(oid("2.5.29.19"), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))),
      seq(oid("2.5.29.17"), tlv(0x04, seq(tlv(0x82, Buffer.from(name))))),
    ),
  );
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.concat([Buffer.from([1]), randomBytes(8)])),
    seq(oid(ECDSA_SHA256)),
    named,
    seq(time(new Date(now - 3_600_000)), time(new Date(now + 86_400_000))),
    named,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = seq(tbs, seq(oid(ECDSA_SHA256)), tlv(0x03, Buffer.from([0]), signature));
  const lines = der.toString("base64").match(/.{1,64}/g)!.join("\n");
  const key = privateKey.export({ type: "pkcs8", format: "pem" });
  return { key: String(key), cert: `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n` };
}
