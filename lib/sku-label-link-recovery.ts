type LinkStatus = {
  sku: string;
  status: "ready" | "pending" | "blocked";
  automaticRetry?: boolean;
  catalogCorrectionPending?: boolean;
  verificationPending?: boolean;
};

export function canAutomaticallyRecoverSkuLink(link: LinkStatus) {
  return !link.verificationPending && !link.catalogCorrectionPending
    && (link.status === "pending" || (link.status === "blocked" && link.automaticRetry === true));
}

type Attempt = { count: number; nextAt: number; expiresAt: number | null; active: boolean };

/** Library loads may grant recovery; observations only stop unsafe or completed work. */
export class SkuLinkRecoveryQueue {
  // Retain spent budgets so refreshing the library cannot start an endless retry loop.
  private readonly attempts = new Map<string, Attempt>();

  grant(links: readonly LinkStatus[], now: number, { reset = false }: { reset?: boolean } = {}) {
    this.expire(now);
    for (const link of links) {
      if (!canAutomaticallyRecoverSkuLink(link)) {
        const attempt = this.attempts.get(link.sku);
        if (attempt) attempt.active = false;
      } else if (reset || !this.attempts.has(link.sku)) {
        this.attempts.set(link.sku, { count: 0, nextAt: now + 15_000, expiresAt: null, active: true });
      } else {
        const attempt = this.attempts.get(link.sku)!;
        attempt.active = attempt.count < 3 && (attempt.expiresAt === null || now < attempt.expiresAt);
      }
    }
  }

  observe(links: readonly LinkStatus[]) {
    for (const link of links) {
      const attempt = this.attempts.get(link.sku);
      if (attempt && !canAutomaticallyRecoverSkuLink(link)) attempt.active = false;
    }
  }

  has(sku: string) {
    const attempt = this.attempts.get(sku);
    return Boolean(attempt?.active && attempt.count < 3);
  }

  skus() { return [...this.attempts.keys()].filter(sku => this.has(sku)); }

  expire(now: number) {
    for (const attempt of this.attempts.values()) {
      if (attempt.expiresAt !== null && now >= attempt.expiresAt) attempt.active = false;
    }
  }

  take(skus: readonly string[], now: number) {
    this.expire(now);
    const due = [...new Set(skus)].filter(sku => this.has(sku) && this.attempts.get(sku)!.nextAt <= now)
      .sort((left, right) => this.attempts.get(left)!.nextAt - this.attempts.get(right)!.nextAt).slice(0, 3);
    for (const sku of due) {
      const attempt = this.attempts.get(sku)!;
      // A queued card gets its own window after reaching the front of the library.
      attempt.expiresAt ??= now + 300_000;
      attempt.nextAt = now + [30_000, 60_000, 120_000][attempt.count];
      attempt.count++;
    }
    return due;
  }
}

/** Read-only verification has a separate budget and can never authorize relinking. */
export class SkuLinkVerificationQueue {
  private readonly attempts = new Map<string, Attempt>();

  observe(links: readonly LinkStatus[], now: number) {
    for (const link of links) {
      if (!link.verificationPending) this.attempts.delete(link.sku);
      else if (!this.attempts.has(link.sku)) {
        this.attempts.set(link.sku, { count: 0, nextAt: now + 15_000, expiresAt: now + 300_000, active: true });
      }
    }
  }

  has(sku: string, now: number) {
    const attempt = this.attempts.get(sku);
    return Boolean(attempt?.active && attempt.count < 3 && attempt.expiresAt !== null && now < attempt.expiresAt);
  }

  take(skus: readonly string[], now: number) {
    const due = [...new Set(skus)].filter(sku => this.has(sku, now) && this.attempts.get(sku)!.nextAt <= now)
      .sort((left, right) => this.attempts.get(left)!.nextAt - this.attempts.get(right)!.nextAt).slice(0, 3);
    for (const sku of due) {
      const attempt = this.attempts.get(sku)!;
      attempt.nextAt = now + [30_000, 60_000, 120_000][attempt.count];
      attempt.count++;
    }
    return due;
  }
}
