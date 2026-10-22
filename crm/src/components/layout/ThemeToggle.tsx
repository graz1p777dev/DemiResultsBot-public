'use client'

import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'

export default function ThemeToggle() {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const saved = localStorage.getItem('demi-theme') === 'dark'
    setDark(saved)
    document.documentElement.classList.toggle('dark', saved)
  }, [])
  const toggle = () => {
    const next = !dark
    setDark(next)
    localStorage.setItem('demi-theme', next ? 'dark' : 'light')
    document.documentElement.classList.toggle('dark', next)
  }
  return <button type="button" onClick={toggle} aria-label={dark ? 'Светлая тема' : 'Тёмная тема'} title={dark ? 'Светлая тема' : 'Тёмная тема'} className="flex size-8 items-center justify-center rounded-lg text-[#075a78] transition hover:bg-[#eaf4f8] dark:text-cyan-200 dark:hover:bg-white/10">{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
}
