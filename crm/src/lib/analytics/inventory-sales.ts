import type { SupabaseClient } from '@supabase/supabase-js'

export interface InventorySalesDay {
  date: string
  sales: number
  returns: number
  productRevenue: number
  deliveryRevenue: number
  revenue: number
}

export async function getUnlinkedInventorySalesDaily(
  supabase: SupabaseClient,
  dateFrom: string,
  dateTo: string,
): Promise<InventorySalesDay[]> {
  const { data, error } = await supabase.rpc('get_unlinked_inventory_sales_daily', {
    p_date_from: dateFrom,
    p_date_to: dateTo,
  })

  if (error) {
    throw new Error(`Не удалось получить продажи товароучёта: ${error.message}`)
  }

  return (data ?? []).map((row: Record<string, unknown>) => ({
    date: String(row.sale_date),
    sales: Number(row.sales_count) || 0,
    returns: Number(row.returns_count) || 0,
    productRevenue: Number(row.product_revenue) || 0,
    deliveryRevenue: Number(row.delivery_revenue) || 0,
    revenue: Number(row.net_revenue) || 0,
  }))
}

export function sumInventorySales(days: InventorySalesDay[]) {
  return days.reduce(
    (sum, day) => ({
      sales: sum.sales + day.sales,
      returns: sum.returns + day.returns,
      productRevenue: sum.productRevenue + day.productRevenue,
      deliveryRevenue: sum.deliveryRevenue + day.deliveryRevenue,
      revenue: sum.revenue + day.revenue,
    }),
    { sales: 0, returns: 0, productRevenue: 0, deliveryRevenue: 0, revenue: 0 },
  )
}
