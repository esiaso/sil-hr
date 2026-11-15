import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '../../config/env';

/**
 * sil_procurement's exit clearance (its README, "HR integration: exit clearance"):
 *
 *   GET {PROCUREMENT_API_URL}/api/v1/integration/hr/staff/{employeeNo}/exit-clearance
 *   x-api-key: <key with the "hr" scope>
 *
 * The staff key is HR's staff number, which procurement stores as the user's employeeNo.
 * The answer lists assets in the person's custody, unretired petty cash advances and
 * petty cash floats, with `cleared` and `blockers`. Read only on both sides.
 */
export interface ProcurementClearance {
  reachable: boolean;
  error: string | null;
  cleared: boolean | null;
  blockers: string[];
  assets: { tagNo: string; description: string | null; serialNo?: string | null; location?: string | null; cost?: string | number | null }[];
  outstanding_advances: { number: string; purpose?: string | null; amount: string | number; overdue?: boolean }[];
  petty_cash_floats: { code: string; name?: string | null; balance?: string | number | null }[];
  checked_at: string | null;
}

@Injectable()
export class ProcurementClient {
  private readonly logger = new Logger('Procurement');

  get configured(): boolean {
    const env = loadEnv();
    return !!env.procurementUrl && !!env.procurementApiKey;
  }

  async exitClearance(staffNumber: string): Promise<ProcurementClearance> {
    const env = loadEnv();
    const empty = { assets: [], outstanding_advances: [], petty_cash_floats: [], blockers: [] };
    if (!env.procurementUrl || !env.procurementApiKey) {
      return { reachable: false, error: 'Procurement is not connected (PROCUREMENT_API_URL / PROCUREMENT_API_KEY). Check assets by hand.', cleared: null, checked_at: null, ...empty };
    }
    const url = `${env.procurementUrl}/api/v1/integration/hr/staff/${encodeURIComponent(staffNumber)}/exit-clearance`;
    try {
      const res = await fetch(url, { headers: { 'x-api-key': env.procurementApiKey, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) return { reachable: true, error: 'Procurement has no user with this staff number (employeeNo). Nothing is recorded against them there.', cleared: true, checked_at: new Date().toISOString(), ...empty };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const b = (await res.json()) as {
        cleared: boolean; blockers?: string[];
        assets?: { tagNo: string; description?: string | null; serialNo?: string | null; location?: string | null; cost?: string | number | null }[];
        outstandingAdvances?: { number: string; purpose?: string | null; amount: string | number; overdue?: boolean }[];
        pettyCashFloats?: { code: string; name?: string | null; balance?: string | number | null }[];
      };
      return {
        reachable: true, error: null, cleared: !!b.cleared, blockers: b.blockers ?? [], checked_at: new Date().toISOString(),
        assets: (b.assets ?? []).map((a) => ({ tagNo: a.tagNo, description: a.description ?? null, serialNo: a.serialNo ?? null, location: a.location ?? null, cost: a.cost ?? null })),
        outstanding_advances: (b.outstandingAdvances ?? []).map((a) => ({ number: a.number, purpose: a.purpose ?? null, amount: a.amount, overdue: !!a.overdue })),
        petty_cash_floats: (b.pettyCashFloats ?? []).map((f) => ({ code: f.code, name: f.name ?? null, balance: f.balance ?? null })),
      };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn({ err: message }, 'Procurement exit clearance failed');
      return { reachable: false, error: `Procurement did not answer (${message}). Try again, or check by hand.`, cleared: null, checked_at: new Date().toISOString(), ...empty };
    }
  }
}
