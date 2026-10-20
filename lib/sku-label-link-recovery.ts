type LinkStatus = {
  sku: string;
  status: "ready" | "pending" | "blocked";
  automaticRetry?: boolean;
  catalogCorrectionPending?: boolean;
};

export function canAutomaticallyRecoverSkuLink(link: LinkStatus) {
  return !link.catalogCorrectionPending && (link.status === "pending" || (link.status === "blocked" && link.automaticRetry === true));
}

type Attempt = { count: number; nextAt: number; expiresAt: number };

/** Only a save or explicit retry grants work; status reads cannot create a queue. */
export class SkuLinkRecoveryQueue {
  private readonly attempts = new Map<string, Attempt>();

  grant(links: readonly LinkStatus[], now: number) {
    for (const link of links) {
      if (canAutomaticallyRecoverSkuLink(link)) this.attempts.set(link.sku, { count: 0, nextAt: now + 15_000, expiresAt: now + 300_000 });
      else this.attempts.delete(link.sku);
    }
  }

  observe(links: readonly LinkStatus[]) {
    for (const link of links) if (!canAutomaticallyRecoverSkuLink(link)) this.attempts.delete(link.sku);
  }

  has(sku: string) {
    const attempt = this.attempts.get(sku);
    return Boolean(attempt && attempt.count < 3);
  }

  skus() { return [...this.attempts.keys()].filter(sku => this.has(sku)); }

  expire(now: number) {
    for (const [sku, attempt] of this.attempts) if (now >= attempt.expiresAt) this.attempts.delete(sku);
  }

  take(skus: readonly string[], now: number) {
    this.expire(now);
    const due = [...new Set(skus)].filter(sku => this.has(sku) && this.attempts.get(sku)!.nextAt <= now)
      .sort((left, right) => this.attempts.get(left)!.nextAt - this.attempts.get(right)!.nextAt).slice(0, 3);
    for (const sku of due) {
      const attempt = this.attempts.get(sku)!;
      attempt.nextAt = now + [30_000, 60_000, 120_000][attempt.count];
      attempt.count++;
    }
    return due;
  }
}
