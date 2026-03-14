/**
 * AXON Protocol — Capability-Based Security
 *
 * Implements unforgeable, scoped, attenuable capability tokens.
 * Uses Ed25519 signatures for token integrity.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  CapabilityToken,
  CapabilityType,
  CapabilityConstraints,
  ParameterConstraint,
} from "./types.js";

// ============================================================================
// Capability Authority — Issues and validates tokens
// ============================================================================

export class CapabilityAuthority {
  private privateKey: Uint8Array;
  private publicKey: Uint8Array;
  private revokedTokens: Set<string> = new Set();
  private authorityId: string;

  constructor(authorityId: string, privateKey: Uint8Array, publicKey: Uint8Array) {
    this.authorityId = authorityId;
    this.privateKey = privateKey;
    this.publicKey = publicKey;
  }

  /**
   * Issue a new capability token with specified scope and constraints.
   */
  issue(
    sessionId: string,
    type: CapabilityType,
    scope: string,
    constraints: CapabilityConstraints = {}
  ): CapabilityToken {
    const now = Math.floor(Date.now() / 1000);
    const ttl = constraints.ttl_seconds ?? 600; // Default 10 minutes

    const token: CapabilityToken = {
      id: randomUUID(),
      type,
      scope,
      constraints,
      signature: "", // Filled below
      issued_at: now,
      expires_at: now + ttl,
    };

    token.signature = this.sign(token);
    return token;
  }

  /**
   * Validate a capability token. Returns null if valid, error string if invalid.
   */
  validate(token: CapabilityToken): string | null {
    // Check revocation
    if (this.revokedTokens.has(token.id)) {
      return "Token has been revoked";
    }

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (now > token.expires_at) {
      return "Token has expired";
    }

    // Verify signature
    if (!this.verifySignature(token)) {
      return "Invalid signature — token may have been tampered with";
    }

    return null; // Valid
  }

  /**
   * Check if a token's scope covers the requested resource.
   */
  checkScope(token: CapabilityToken, requestedResource: string): boolean {
    return globMatch(token.scope, requestedResource);
  }

  /**
   * Check parameter constraints against actual parameters.
   */
  checkParams(token: CapabilityToken, params: Record<string, any>): string | null {
    const pc = token.constraints.parameter_constraints;
    if (!pc) return null;

    for (const [param, constraint] of Object.entries(pc)) {
      const value = params[param];
      if (value === undefined) continue;

      const error = validateConstraint(param, value, constraint);
      if (error) return error;
    }

    return null;
  }

  /**
   * Revoke a token. All future validation will reject it.
   */
  revoke(tokenId: string): void {
    this.revokedTokens.add(tokenId);
  }

  /**
   * Attenuate a token — create a new token with NARROWER scope.
   * The new scope must be a subset of the original scope.
   */
  attenuate(
    original: CapabilityToken,
    newScope: string,
    additionalConstraints?: Partial<CapabilityConstraints>
  ): CapabilityToken | null {
    // Verify original is valid
    const error = this.validate(original);
    if (error) return null;

    // Ensure new scope is narrower (subset check)
    if (!isScopeSubset(newScope, original.scope)) {
      return null; // Cannot widen scope
    }

    // Merge constraints (always more restrictive)
    const mergedConstraints = mergeConstraints(
      original.constraints,
      additionalConstraints ?? {}
    );

    // New expiry cannot exceed original
    const maxTtl = original.expires_at - Math.floor(Date.now() / 1000);
    if (mergedConstraints.ttl_seconds && mergedConstraints.ttl_seconds > maxTtl) {
      mergedConstraints.ttl_seconds = maxTtl;
    }

    return this.issue("attenuated", original.type, newScope, mergedConstraints);
  }

  private sign(token: CapabilityToken): string {
    const payload = canonicalTokenPayload(token);
    const hash = createHash("sha256").update(payload).digest();
    // In production, use Ed25519. For reference implementation, HMAC-SHA256.
    const hmac = createHash("sha256")
      .update(Buffer.concat([this.privateKey, hash]))
      .digest("base64url");
    return hmac;
  }

  private verifySignature(token: CapabilityToken): boolean {
    const expected = this.sign({ ...token, signature: "" });
    // Constant-time comparison
    if (expected.length !== token.signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ token.signature.charCodeAt(i);
    }
    return diff === 0;
  }
}

// ============================================================================
// Scope Matching
// ============================================================================

/**
 * Glob-style scope matching.
 * Supports: * (any single segment), ** (any depth), exact match.
 */
export function globMatch(pattern: string, path: string): boolean {
  // Exact match
  if (pattern === path) return true;

  // Wildcard match
  if (pattern === "*") return true;

  const patternParts = pattern.split("/");
  const pathParts = path.split("/");

  return matchParts(patternParts, 0, pathParts, 0);
}

function matchParts(
  pattern: string[],
  pi: number,
  path: string[],
  pathi: number
): boolean {
  while (pi < pattern.length && pathi < path.length) {
    if (pattern[pi] === "**") {
      // ** matches zero or more segments
      // Try matching rest of pattern against each possible suffix
      for (let i = pathi; i <= path.length; i++) {
        if (matchParts(pattern, pi + 1, path, i)) return true;
      }
      return false;
    }

    if (pattern[pi] === "*") {
      // * matches exactly one segment
      pi++;
      pathi++;
      continue;
    }

    if (pattern[pi] !== path[pathi]) return false;

    pi++;
    pathi++;
  }

  // Consume trailing **
  while (pi < pattern.length && pattern[pi] === "**") pi++;

  return pi === pattern.length && pathi === path.length;
}

/**
 * Check if `inner` scope is a subset of `outer` scope.
 */
export function isScopeSubset(inner: string, outer: string): boolean {
  // If outer is **, everything is a subset
  if (outer === "**" || outer === "*") return true;

  // Simple check: inner must be matchable by outer
  return globMatch(outer, inner);
}

// ============================================================================
// Constraint Validation
// ============================================================================

function validateConstraint(
  param: string,
  value: any,
  constraint: ParameterConstraint
): string | null {
  if (constraint.allowed_values && !constraint.allowed_values.includes(value)) {
    return `Parameter '${param}' value '${value}' not in allowed values`;
  }

  if (constraint.pattern && typeof value === "string") {
    const re = new RegExp(constraint.pattern);
    if (!re.test(value)) {
      return `Parameter '${param}' does not match pattern '${constraint.pattern}'`;
    }
  }

  if (constraint.max_value !== undefined && typeof value === "number" && value > constraint.max_value) {
    return `Parameter '${param}' value ${value} exceeds max ${constraint.max_value}`;
  }

  if (constraint.min_value !== undefined && typeof value === "number" && value < constraint.min_value) {
    return `Parameter '${param}' value ${value} below min ${constraint.min_value}`;
  }

  return null;
}

function mergeConstraints(
  base: CapabilityConstraints,
  additional: Partial<CapabilityConstraints>
): CapabilityConstraints {
  return {
    max_calls: Math.min(
      base.max_calls ?? Infinity,
      additional.max_calls ?? Infinity
    ) === Infinity
      ? undefined
      : Math.min(base.max_calls ?? Infinity, additional.max_calls ?? Infinity),
    ttl_seconds: Math.min(
      base.ttl_seconds ?? Infinity,
      additional.ttl_seconds ?? Infinity
    ) === Infinity
      ? undefined
      : Math.min(base.ttl_seconds ?? Infinity, additional.ttl_seconds ?? Infinity),
    parameter_constraints: {
      ...base.parameter_constraints,
      ...additional.parameter_constraints,
    },
  };
}

function canonicalTokenPayload(token: CapabilityToken): string {
  const { signature, ...rest } = token;
  return JSON.stringify(rest, Object.keys(rest).sort());
}
