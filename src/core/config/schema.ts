/*
 * Centralizes configuration vocabulary that lower-level consumers can share
 * without depending on the configuration-loading layer. The target schema is
 * imported from core IR rather than recreated here so plans, digest inputs,
 * browser ports, and config files have one target definition to evolve.
 */

import { z } from 'zod';
import { TargetDefinition } from '#core/ir/schema.js';

/**
 * Validates the parsed contents of a present Ambercast configuration file.
 *
 * @remarks
 * A file that exists must identify its schema through `$schema`, while every
 * setting remains optional to support partial overrides. The no-file case is
 * a separate valid input handled outside this schema. Its `targets` member
 * deliberately reuses {@link TargetDefinition}, preserving one target
 * contract across every core consumer.
 */
export const RawConfig = z.strictObject({
  $schema: z.string(),
  testDir: z.string().optional(),
  runsDir: z.string().optional(),
  testMatch: z.array(z.string()).optional(),
  testIgnore: z.array(z.string()).optional(),
  targets: z.record(z.string(), TargetDefinition).optional(),
  defaultTarget: z.string().optional(),
  ai: z.strictObject({
    provider: z.enum(['claude', 'codex', 'auto']).optional(),
    // A positive timeout bounds each provider call after configuration resolves.
    timeoutMs: z.int().positive().optional(),
  }).optional(),
  viewer: z.strictObject({
    port: z.int().min(1).max(65_535).optional(),
  }).optional(),
  ci: z.strictObject({
    heal: z.boolean().optional(),
    updateGroundingCache: z.boolean().optional(),
  }).optional(),
});

/**
 * Represents the validated shape of a present partial configuration file.
 *
 * This inferred type stays coupled to {@link RawConfig}, so a schema change
 * cannot quietly leave parsed configuration consumers on a different shape.
 */
export type RawConfig = z.infer<typeof RawConfig>;

/**
 * Supplies only the resolved paths required to derive test companion layout.
 *
 * @remarks
 * Keeping this surface to two absolute, normalized, dot-segment-free paths
 * lets core layout remain independent of targets, AI settings, viewer
 * settings, and CI policy, which do not affect path derivation.
 */
export interface LayoutConfig {
  readonly testDir: string;
  readonly runsDir: string;
}

/**
 * Describes the complete, resolved configuration supplied to application
 * consumers.
 *
 * @remarks
 * This type structurally extends {@link LayoutConfig}, allowing a complete
 * configuration to satisfy the layout resolver without an adapter or a
 * duplicate path representation. Nested values are readonly so loading can
 * establish one stable configuration snapshot.
 */
export interface ResolvedConfig extends LayoutConfig {
  readonly testMatch: readonly string[];
  readonly testIgnore: readonly string[];
  readonly targets: Readonly<Record<string, Readonly<TargetDefinition>>>;
  readonly defaultTarget?: string;
  /** AI-provider policy with a positive, resolved per-call timeout. */
  readonly ai: Readonly<{ provider: 'claude' | 'codex' | 'auto'; timeoutMs: number }>;
  readonly viewer: Readonly<{ port: number }>;
  readonly ci: Readonly<{ heal: boolean; updateGroundingCache: boolean }>;
}

/**
 * Captures configuration-related environment values before domain validation.
 *
 * @remarks
 * `aiProviderRaw` remains a plain string because the system adapter that reads
 * the environment only captures external data. Configuration loading owns
 * validation against the supported provider vocabulary, keeping that adapter
 * free of configuration-domain policy.
 */
export interface ConfigEnvSnapshot {
  readonly configPathOverride?: string;
  readonly aiProviderRaw?: string;
}
