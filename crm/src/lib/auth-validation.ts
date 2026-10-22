// Правила валидации пароля — одно место для фронта и бэка

export const PASSWORD_MIN_LENGTH = 10

export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Минимум ${PASSWORD_MIN_LENGTH} символов`
  }
  if (!/[A-Z]/.test(password)) {
    return 'Обязательна хотя бы одна заглавная буква'
  }
  if (!/[0-9]/.test(password)) {
    return 'Обязательна хотя бы одна цифра'
  }
  return null
}

export function passwordStrength(password: string): 'weak' | 'medium' | 'strong' {
  let score = 0
  if (password.length >= 10) score++
  if (password.length >= 14) score++
  if (/[A-Z]/.test(password)) score++
  if (/[0-9]/.test(password)) score++
  if (/[^A-Za-z0-9]/.test(password)) score++
  if (score <= 2) return 'weak'
  if (score <= 3) return 'medium'
  return 'strong'
}
