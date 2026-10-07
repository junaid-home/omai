import type { JSX } from "solid-js"
import { useLanguage } from "@/context/language"

export function AuthSurface(props: { children: JSX.Element }) {
  const language = useLanguage()
  return (
    <div data-component="auth-surface">
      <div class="auth-backdrop" aria-hidden="true">
        <span class="auth-glow auth-glow-core" />
        <span class="auth-glow auth-glow-top" />
        <span class="auth-glow auth-glow-bottom" />
        <svg class="auth-aperture" viewBox="0 0 800 800" fill="none">
          <g class="auth-aperture-rotor">
            <circle class="auth-aperture-ring" cx="400" cy="400" r="372" />
            <circle class="auth-aperture-ring" cx="400" cy="400" r="304" />
            <circle class="auth-aperture-ring" cx="400" cy="400" r="236" />
            {Array.from({ length: 9 }, (_, i) => (
              <path
                class="auth-aperture-blade"
                d="M400 96 L578 86"
                transform={`rotate(${i * 40} 400 400)`}
              />
            ))}
            <path class="auth-aperture-arc" d="M400 44 A356 356 0 0 1 756 400" />
            <path class="auth-aperture-arc auth-aperture-arc-faint" d="M400 756 A356 356 0 0 1 44 400" />
          </g>
        </svg>
        <span class="auth-arc auth-arc-a" />
        <span class="auth-arc auth-arc-b" />
        <span class="auth-dots" />
        <span class="auth-vignette" />
      </div>

      <main class="auth-shell">
        <span class="auth-card-glow" aria-hidden="true" />
        <div class="auth-card">{props.children}</div>
        <p class="auth-footnote">
          <span class="auth-status" aria-hidden="true" />
          {language.t("auth.login.stealthMode")}
        </p>
      </main>
    </div>
  )
}

export function AuthHead(props: { title: string; subtitle: string }) {
  return (
    <div class="auth-head">
      <div class="auth-logo">
        <span class="auth-logo-halo" aria-hidden="true" />
        <span class="auth-logo-ring" aria-hidden="true" />
        <img src="/icon.jpeg" alt="O M A I +" class="auth-logo-img" width={76} height={76} />
      </div>
      <h1 class="auth-title">{props.title}</h1>
      <p class="auth-subtitle">{props.subtitle}</p>
    </div>
  )
}
