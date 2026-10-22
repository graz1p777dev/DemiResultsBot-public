import 'server-only'
import { createHmac } from 'node:crypto'

export const MINI_PASSWORD_COOKIE = 'dr_mini_auth'

function miniPasswordSecret(): string {
  return process.env.MINI_PASSWORD_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'demi-results-mini-password'
}

export function normalizeMiniPassword(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function signMiniPasswordCookie(employeeId: string, userId: string): string {
  return createHmac('sha256', miniPasswordSecret()).update(`${employeeId}:${userId}`).digest('hex')
}

export function buildMiniPasswordCookie(employeeId: string, userId: string): string {
  return `${employeeId}.${signMiniPasswordCookie(employeeId, userId)}`
}

export function isMiniPasswordCookieValid(value: string | undefined, employeeId: string, userId: string): boolean {
  if (!value) return false
  return value === buildMiniPasswordCookie(employeeId, userId)
}
