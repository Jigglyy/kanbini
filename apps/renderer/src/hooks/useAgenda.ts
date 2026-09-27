import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { localDayStart } from '@kanbini/shared'
import { ipc } from '../lib/ipc'

// Boards-home agenda query. The change-event listener in App.tsx
// invalidates `agendaKey` after every mutation (same live contract as
// the board view and the boards list), so AI edits and edits made on a
// board show up when the user comes back home.
//
// "Today" is a local calendar day, so an agenda left on screen past
// midnight would keep yesterday's buckets. A timer refetches just after
// each local midnight.
export const agendaKey = ['agenda'] as const

export function useAgenda() {
  const qc = useQueryClient()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = (): void => {
      const msToMidnight = localDayStart(Date.now(), 1) - Date.now()
      timer = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: agendaKey })
        schedule()
      }, msToMidnight + 1000)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [qc])

  return useQuery({
    queryKey: agendaKey,
    queryFn: () => ipc.agenda({})
  })
}
