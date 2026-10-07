import {chmod, lstat, mkdir, open, readFile, rename, rm} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {z} from "zod";
import {identitySchema, type Identity} from "./client.js";

// Optional private storage for one participant, enabled only when the host sets CAIRN_HOME to a directory the user
// chose. It holds the Agent Card (no secret), the user's recorded permission, and, only if that permission says so,
// the Cairn-only agent credential. Files are 0600 in a 0700 directory; tool results never include paths or tokens.
const tokenPattern = /^crn_[A-Za-z0-9_-]{43}$/;
export const consentSchema = z.object({
  scope: z.literal("a2a_source_review"),
  mode: z.enum(["this_action","ongoing"]),
  max_per_visit: z.number().int().min(1).max(5).default(3),
  persist_identity: z.boolean().default(false),
}).strict();
export type Consent = z.infer<typeof consentSchema>;
const identityFile = z.object({token:z.string().regex(tokenPattern),identity:identitySchema}).strict();
export class StoreError extends Error {}

export class LocalStore {
  private constructor(private dir: string) {}
  static fromEnv(env: Record<string,string|undefined> = process.env) {
    const dir = env.CAIRN_HOME;
    if (!dir) return undefined;
    if (!path.isAbsolute(dir) || dir.split(path.sep).includes("..")) throw new StoreError("CAIRN_HOME must be an absolute path without '..'.");
    return new LocalStore(path.normalize(dir));
  }
  static at(dir: string) { return new LocalStore(dir); }
  private async ensureDir() {
    await mkdir(this.dir,{recursive:true,mode:0o700});
    const info = await lstat(this.dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreError("The storage location is not a plain directory.");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new StoreError("The storage directory belongs to another user.");
    if ((info.mode & 0o077) !== 0) throw new StoreError("The storage directory is accessible to others; make it private (0700) first.");
  }
  private async read(name: string): Promise<string | undefined> {
    try {
      const file = path.join(this.dir,name);
      const info = await lstat(file);
      if (!info.isFile() || (info.mode & 0o077) !== 0) throw new StoreError(`${name} must be a regular private file (0600).`);
      return await readFile(file,"utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async write(name: string, text: string) {
    await this.ensureDir();
    const target = path.join(this.dir,name);
    const temp = `${target}.${process.pid}.tmp`;
    const handle = await open(temp,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
    try { await handle.writeFile(text); } finally { await handle.close(); }
    try { await chmod(temp,0o600); await rename(temp,target); } catch (error) { await rm(temp,{force:true}); throw error; }
  }
  async readConsent(): Promise<Consent | undefined> {
    const text = await this.read("consent.json");
    return text === undefined ? undefined : consentSchema.parse(JSON.parse(text).consent);
  }
  async writeConsent(consent: Consent) {
    await this.write("consent.json",JSON.stringify({consent,recorded_at:new Date().toISOString()},null,2) + "\n");
  }
  async readCard(): Promise<{card:unknown;digest:string} | undefined> {
    const text = await this.read("agent-card.json");
    return text === undefined ? undefined : JSON.parse(text);
  }
  async writeCard(card: unknown, digest: string) { await this.write("agent-card.json",JSON.stringify({card,digest},null,2) + "\n"); }
  // Saves the first card automatically and never replaces an existing one; returns whether it wrote.
  async writeCardIfAbsent(card: unknown, digest: string) {
    if (await this.readCard()) return false;
    await this.writeCard(card,digest);
    return true;
  }
  async readIdentity(): Promise<{token:string;identity:Identity} | undefined> {
    const text = await this.read("identity.json");
    return text === undefined ? undefined : identityFile.parse(JSON.parse(text));
  }
  async writeIdentity(token: string, identity: Identity) { await this.write("identity.json",JSON.stringify(identityFile.parse({token,identity})) + "\n"); }
}
