import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FlowGraph } from '../compiler/compiler.service';
import { config } from '../../core/config';
import { buildToolDefs, heroActionOf } from './tool-schema';

export interface PublishedSkill {
  id: string;
  name: string;
  description: string;
  flow: FlowGraph;
  toolDefs: ReturnType<typeof buildToolDefs>;
  policyId?: string;
  createdAt: string;
  /**
   * Sui address that published this skill, when it was published through an authenticated call.
   *
   * Optional, and permanently so: every skill published before the authorization server existed has
   * no owner, and those links must keep working on the public `/api/mcp/:skillId` endpoint. An
   * unowned skill is simply invisible to the owner-scoped `/mcp` endpoint, which serves an exact
   * address match only — a skill with no owner matches no address, so it can never leak into
   * someone else's catalogue.
   */
  owner?: string;
}

/**
 * Persistent store for published skills. Published MCP/skill links must survive restarts + redeploys
 * (an in-memory map would 404 every shared link after a deploy), so this is backed by a JSON file.
 * Single-instance, low write volume (only on publish) → a load-on-boot + atomic write-on-save is enough.
 * ponytail: file store, swap for a DB if skills ever need multi-instance or high write throughput.
 */
class SkillsStore {
  private skills = new Map<string, PublishedSkill>();
  private readonly path = config.skillsStorePath;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as PublishedSkill[];
      for (const skill of raw) {
        // Rehydrate every published skill regardless of action type. Prefer the stored
        // name/description; fall back to the flow-derived hero label for older records that
        // predate flow-aware naming (they were all saved as the DeepBook hero).
        const hero = heroActionOf(skill.flow);
        this.skills.set(skill.id, {
          ...skill,
          name: skill.name ?? hero.name,
          description: skill.description ?? hero.description,
          toolDefs: buildToolDefs(skill.flow, skill.id),
        });
      }
      console.log(`[skills] loaded ${this.skills.size} published skill(s) from ${this.path}`);
    } catch (err) {
      console.error(`[skills] failed to load ${this.path} — starting empty:`, (err as Error).message);
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.skills.values()], null, 2));
      renameSync(tmp, this.path); // atomic swap — never leaves a half-written file
    } catch (err) {
      console.error(`[skills] failed to persist ${this.path}:`, (err as Error).message);
    }
  }

  save(skill: PublishedSkill): void {
    this.skills.set(skill.id, skill);
    this.persist();
  }

  get(id: string): PublishedSkill | undefined {
    return this.skills.get(id);
  }

  list(): PublishedSkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Skills owned by one Sui address, newest first — the owner-scoped MCP endpoint's catalogue.
   *
   * Exact match on a normalized address, never a prefix or a case-insensitive contains: this is an
   * authorization boundary, and the only thing standing between one user's catalogue and another's.
   * An address that owns nothing gets an empty list, which is a valid state (connected but nothing
   * published yet), not an error.
   */
  listByOwner(address: string): PublishedSkill[] {
    const wanted = address.trim().toLowerCase();
    if (wanted === '') return [];
    return Array.from(this.skills.values())
      .filter((skill) => skill.owner?.trim().toLowerCase() === wanted)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export const skillsStore = new SkillsStore();
