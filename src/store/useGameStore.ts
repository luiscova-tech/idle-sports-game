import { create } from 'zustand'

interface GameState {
  isInitialized: boolean
}

export const useGameStore = create<GameState>(() => ({
  isInitialized: true,
}))
