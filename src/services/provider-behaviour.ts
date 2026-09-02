import { config } from '../config.ts'

export type Behaviour = { errorRate: number; timeoutRate: number }

export const providerBehaviour: Record<'a' | 'b', Behaviour> = {
  a: { errorRate: config.PROVIDER_A_ERROR_RATE, timeoutRate: config.PROVIDER_A_TIMEOUT_RATE },
  b: { errorRate: config.PROVIDER_B_ERROR_RATE, timeoutRate: config.PROVIDER_B_TIMEOUT_RATE }
}

export function setProviderBehaviour(provider: 'a' | 'b', behaviour: Partial<Behaviour>): void {
  providerBehaviour[provider] = { ...providerBehaviour[provider], ...behaviour }
}

export function resetProviderBehaviour(): void {
  providerBehaviour.a = {
    errorRate: config.PROVIDER_A_ERROR_RATE,
    timeoutRate: config.PROVIDER_A_TIMEOUT_RATE
  }
  providerBehaviour.b = {
    errorRate: config.PROVIDER_B_ERROR_RATE,
    timeoutRate: config.PROVIDER_B_TIMEOUT_RATE
  }
}
