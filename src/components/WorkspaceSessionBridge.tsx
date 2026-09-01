import { useEffect, useRef } from 'react'
import { api, ws } from '@/api/client'
import { useAuth } from '@/stores/auth'

/** Keeps the auth company's list in sync when another owner/admin changes this
 * user's role or removes/deletes a workspace. The server targets terminal
 * removal frames directly, so this also works after membership is gone. */
export function WorkspaceSessionBridge() {
  const meId = useAuth((s) => s.user?.id ?? null)
  const setMe = useAuth((s) => s.setMe)
  const setServerCapabilities = useAuth((s) => s.setServerCapabilities)
  const refreshing = useRef(false)
  const refreshQueued = useRef(false)

  useEffect(() => {
    void ws.connect()

    const refreshMembership = async () => {
      if (refreshing.current) {
        refreshQueued.current = true
        return
      }
      refreshing.current = true
      try {
        do {
          refreshQueued.current = false
          try {
            const session = await api.authMe()
            setMe(session.user, session.companies, session.activeCompanyId)
            setServerCapabilities(session.serverCapabilities)
          } catch (error) {
            console.warn('[workspace] failed to refresh membership state', error)
          }
        } while (refreshQueued.current)
        ws.reconnect()
      } finally {
        refreshing.current = false
      }
    }

    return ws.on((event) => {
      if (event.type !== 'workspace.membership' || !meId || !event.recipientUserIds.includes(meId)) return
      void refreshMembership()
    })
  }, [meId, setMe, setServerCapabilities])

  return null
}
