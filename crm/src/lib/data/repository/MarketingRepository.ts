// ─── MarketingRepository ──────────────────────────────────────────────────────

import type { IMarketingAdapter } from '../contracts/IMarketingAdapter'
import type { ICache } from '../contracts/ICache'
import type { MarketingData } from '@/lib/models/marketing'
import { MarketingMapper } from '../mappers/marketing.mapper'
import { MockMarketingAdapter } from '../adapters/marketing/MockMarketingAdapter'
import { globalCache } from '../cache/MemoryCache'

const TTL_MS = 60_000

export class MarketingRepository {
  constructor(
    private readonly adapter: IMarketingAdapter,
    private readonly cache:   ICache,
  ) {}

  async getData(year: number, month: number): Promise<MarketingData> {
    const key    = `marketing:${year}:${month}`
    const cached = this.cache.get<MarketingData>(key)
    if (cached) return cached

    const raw  = await this.adapter.fetchData(year, month)
    const data = MarketingMapper.map(raw)
    this.cache.set(key, data, TTL_MS)
    return data
  }

  invalidate(year: number, month: number): void {
    this.cache.invalidate(`marketing:${year}:${month}`)
  }
}

// Синглтон — заменить MockMarketingAdapter на реальный когда будет готово API
export const marketingRepository = new MarketingRepository(
  new MockMarketingAdapter(),
  globalCache,
)
