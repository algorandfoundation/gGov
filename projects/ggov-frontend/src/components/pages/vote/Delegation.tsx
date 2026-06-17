import { useState } from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { useGGovSDK } from '@/hooks/useGGovSDK'
import { useDelegation } from '@/hooks/queries'
import { useDelegateMutation, useUndelegateMutation } from '@/hooks/mutations'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import Address from '@/components/Address'
import { TxButtonContent } from '@/components/TxButtonContent'

export default function Delegation() {
  const { sdk } = useGGovSDK()
  const { activeAddress } = useWallet()
  const { data: delegation, isLoading } = useDelegation(activeAddress)
  const delegateMutation = useDelegateMutation()
  const undelegateMutation = useUndelegateMutation()

  const [delegateeInput, setDelegateeInput] = useState('')

  const submitting = delegateMutation.isPending || undelegateMutation.isPending

  if (!activeAddress) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Delegation</h1>
        <p className="text-muted-foreground">Connect your wallet to manage delegation.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Delegation</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current delegation</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : delegation?.exists ? (
            <div className="space-y-3">
              <p className="text-sm">
                Delegated to: <Address address={delegation.delegatee} to width={8} className="text-primary hover:underline" />
              </p>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => undelegateMutation.mutate()}
                disabled={submitting}
                aria-busy={undelegateMutation.isPending}
              >
                <TxButtonContent
                  pending={undelegateMutation.isPending}
                  success={undelegateMutation.isSuccess}
                  idleLabel="Remove delegation"
                  pendingLabel="Removing…"
                  confirmedLabel="Removed"
                />
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No active delegation.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Set delegation</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="delegatee-address">Delegatee address</Label>
              <Input
                id="delegatee-address"
                name="delegatee-address"
                placeholder="Enter Algorand address..."
                value={delegateeInput}
                onChange={(e) => setDelegateeInput(e.target.value)}
              />
            </div>
            <Button
              onClick={() => delegateMutation.mutate(delegateeInput)}
              disabled={submitting || !delegateeInput || !sdk}
              aria-busy={delegateMutation.isPending}
            >
              <TxButtonContent
                pending={delegateMutation.isPending}
                success={delegateMutation.isSuccess}
                idleLabel="Delegate"
                pendingLabel="Delegating…"
                confirmedLabel="Delegated"
              />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
