import { useState, type FormEvent } from 'react'
import type { SyncMergePreview, SyncProposal } from './appSync'
import type { SyncClientPairing } from './syncClient'

export type SyncHostInfo = { status: 'stopped' | 'listening' | 'tailscale-not-found' | 'tailscale-cli-not-found' | 'tailscale-dns-unavailable' | 'serve-error' | 'port-in-use' | 'start-error'; address?: string; publicUrl?: string; port?: number; code?: string; expiresAt?: string; detail?: string }
export type SyncClientStatus = 'idle' | 'pairing' | 'paired' | 'syncing' | 'uploaded' | 'error'
export type SyncPairRequest = { requestId: string; clientName: string; sourceAddress: string; expiresAt: string }
export type SyncPairedClient = { clientId: string; clientName: string; sourceAddress: string; expiresAt: string }
export type SyncMergeReview = { proposal: SyncProposal; preview: SyncMergePreview }

function formatSyncCredits(value: number) {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} aUEC`
}

export function SyncSettings({
  desktopAvailable,
  hostInfo,
  pairRequests,
  pairedClients,
  proposals,
  mergeReview,
  clientPairing,
  clientStatus,
  lastUploadedAt,
  error,
  onStartHost,
  onRotateCode,
  onStopHost,
  onApprovePair,
  onRejectPair,
  onRevokeClient,
  onReviewProposal,
  onDismissProposal,
  onApplyMerge,
  onCloseMergeReview,
  onConnectClient,
  onDisconnectClient,
  onUploadNow,
}: {
  desktopAvailable: boolean
  hostInfo: SyncHostInfo
  pairRequests: SyncPairRequest[]
  pairedClients: SyncPairedClient[]
  proposals: SyncProposal[]
  mergeReview: SyncMergeReview | null
  clientPairing: SyncClientPairing | null
  clientStatus: SyncClientStatus
  lastUploadedAt: string
  error: string
  onStartHost: () => void
  onRotateCode: () => void
  onStopHost: () => void
  onApprovePair: (requestId: string) => void
  onRejectPair: (requestId: string) => void
  onRevokeClient: (clientId: string) => void
  onReviewProposal: (proposal: SyncProposal) => void
  onDismissProposal: (proposalId: string) => void
  onApplyMerge: () => void
  onCloseMergeReview: () => void
  onConnectClient: (primaryUrl: string, code: string, clientName: string) => void
  onDisconnectClient: () => void
  onUploadNow: () => void
}) {
  const [primaryUrl, setPrimaryUrl] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [clientName, setClientName] = useState('SC Command Hub client')

  function submitPairing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onConnectClient(primaryUrl, pairingCode, clientName)
  }

  const hostStatus = hostInfo.status === 'listening'
    ? `Listening securely at ${hostInfo.publicUrl ?? hostInfo.address}`
    : hostInfo.status === 'tailscale-not-found'
      ? 'Connect this device to Tailscale before hosting.'
      : hostInfo.status === 'tailscale-cli-not-found' ? 'Install and sign in to Tailscale to host.'
        : hostInfo.status === 'tailscale-dns-unavailable' ? 'Tailscale Serve could not obtain this device’s DNS certificate.'
          : hostInfo.status === 'serve-error' ? hostInfo.detail || 'Tailscale Serve could not start.'
      : hostInfo.status === 'port-in-use'
        ? 'The sync port is already in use.'
        : hostInfo.status === 'start-error' ? 'The listener could not start.' : 'Listener stopped.'
  const clientStatusLabel = clientStatus === 'syncing' ? 'UPLOADING' : clientStatus === 'uploaded' ? 'UPLOADED FOR REVIEW' : clientStatus === 'paired' ? 'PAIRED' : clientStatus === 'pairing' ? 'WAITING FOR APPROVAL' : clientStatus === 'error' ? 'CONNECTION ERROR' : 'NOT PAIRED'

  return <>
    <section className="data-section app-sync-section">
      <div className="section-toolbar"><div><h2>Primary listener</h2><span>Private Tailscale network · incoming changes require review</span></div><span className="table-label">{hostInfo.status === 'listening' ? 'LISTENING' : 'DESKTOP HOST'}</span></div>
      <div className="sync-section-content">
        {!desktopAvailable ? <p className="sync-status-copy">This browser or mobile app can upload as a client, but only the desktop app can host.</p> : <>
          <div className="sync-host-controls"><span className="sync-status-copy">{hostStatus}</span>{hostInfo.status === 'listening'
            ? <div className="sync-action-row"><button className="secondary-button" type="button" onClick={onRotateCode}>New pairing code</button><button className="danger-button" type="button" onClick={onStopHost}>Stop listener</button></div>
            : <button className="primary-button" type="button" onClick={onStartHost}>Start listener</button>}</div>
          {hostInfo.status === 'listening' && hostInfo.code && <div className="sync-pairing-code"><span>PAIRING CODE · EXPIRES {hostInfo.expiresAt ? new Date(hostInfo.expiresAt).toLocaleTimeString() : 'SOON'}</span><strong>{hostInfo.code}</strong><small>Share this code only with the device you intend to pair.</small></div>}
          {pairRequests.length > 0 && <div className="sync-review-list"><h3>Pairing requests</h3>{pairRequests.map((request) => <div className="sync-review-row" key={request.requestId}>
            <div><strong>{request.clientName}</strong><small>Expires {new Date(request.expiresAt).toLocaleTimeString()}</small></div>
            <div className="sync-action-row"><button className="primary-button" type="button" onClick={() => onApprovePair(request.requestId)}>Approve</button><button className="danger-button" type="button" onClick={() => onRejectPair(request.requestId)}>Reject</button></div>
          </div>)}</div>}
          {pairedClients.length > 0 && <div className="sync-review-list"><h3>Paired devices</h3>{pairedClients.map((client) => <div className="sync-review-row" key={client.clientId}>
            <div><strong>{client.clientName}</strong><small>Expires {new Date(client.expiresAt).toLocaleString()}</small></div>
            <button className="danger-button" type="button" onClick={() => onRevokeClient(client.clientId)}>Revoke</button>
          </div>)}</div>}
          {proposals.length > 0 && <div className="sync-review-list"><h3>Incoming snapshots</h3>{proposals.map((proposal) => <div className="sync-review-row" key={proposal.id}>
            <div><strong>{proposal.clientName}</strong><small>Received {new Date(proposal.receivedAt).toLocaleString()}</small></div>
            <div className="sync-action-row"><button className="secondary-button" type="button" onClick={() => onReviewProposal(proposal)}>Review merge</button><button className="text-button" type="button" onClick={() => onDismissProposal(proposal.id)}>Dismiss</button></div>
          </div>)}</div>}
        </>}
      </div>
    </section>

    <section className="data-section app-sync-section">
      <div className="section-toolbar"><div><h2>Connect to primary</h2><span>Upload local app data to a paired desktop over Tailscale.</span></div><span className="table-label">{clientStatusLabel}</span></div>
      <div className="sync-section-content">
        {clientPairing ? <div className="sync-host-controls"><div><strong className="sync-status-copy">Paired to {clientPairing.primaryUrl}</strong><small className="sync-last-upload">{lastUploadedAt ? `Last upload ${new Date(lastUploadedAt).toLocaleString()}` : 'Waiting for initial upload'}</small></div><div className="sync-action-row"><button className="secondary-button" type="button" disabled={clientStatus === 'syncing'} onClick={onUploadNow}>Sync now</button><button className="danger-button" type="button" onClick={onDisconnectClient}>Disconnect</button></div></div> : <form className="sync-client-form" onSubmit={submitPairing}>
          <label><span>PRIMARY TAILSCALE HTTPS URL</span><input value={primaryUrl} onChange={(event) => setPrimaryUrl(event.target.value)} placeholder="https://primary.tailnet.ts.net:8443/sc-command-hub-sync" required /></label>
          <label><span>DEVICE NAME</span><input value={clientName} onChange={(event) => setClientName(event.target.value)} maxLength={80} required /></label>
          <label><span>PAIRING CODE</span><input value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} placeholder="6 digits" inputMode="numeric" maxLength={6} required /></label>
          <button className="primary-button" type="submit" disabled={clientStatus === 'pairing'}>{clientStatus === 'pairing' ? 'Waiting for approval…' : 'Request pairing'}</button>
        </form>}
        {error && <div className="form-error sync-error" role="alert">{error}</div>}
        <div className="table-note"><span>One-way upload only; primary data is never sent back.</span><span>UEX tokens and game paths are excluded.</span></div>
      </div>
    </section>

    {mergeReview && <SyncMergeReviewDialog review={mergeReview} onClose={onCloseMergeReview} onApply={onApplyMerge} />}
  </>
}

function SyncMergeReviewDialog({ review, onClose, onApply }: { review: SyncMergeReview; onClose: () => void; onApply: () => void }) {
  const totalAdded = Object.values(review.preview.stats).reduce((sum, stat) => sum + stat.added, 0)
  const totalDuplicates = Object.values(review.preview.stats).reduce((sum, stat) => sum + stat.duplicates, 0)
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="record-modal sync-merge-modal" role="alertdialog" aria-modal="true" aria-labelledby="sync-merge-title">
      <div className="record-modal-head"><div><span className="eyebrow">PRIMARY DEVICE · MERGE PREVIEW</span><h2 id="sync-merge-title">Merge {review.proposal.clientName}?</h2></div><button className="close-button" type="button" onClick={onClose} aria-label="Close merge review">×</button></div>
      <div className="sync-merge-summary"><strong>{totalAdded} new records</strong><span>{totalDuplicates} duplicates skipped</span><span>{review.preview.conflicts.length} conflicts</span></div>
      <div className="sync-merge-stats">{Object.entries(review.preview.stats).filter(([, stat]) => stat.added || stat.duplicates || stat.conflicts).map(([category, stat]) => <div key={category}><strong>{category}</strong><span>{stat.added} added · {stat.duplicates} duplicate · {stat.conflicts} conflict</span></div>)}</div>
      {review.preview.accountBalanceChanges.length > 0 && <div className="sync-balance-review"><h3>Account balance impact</h3>{review.preview.accountBalanceChanges.map((change) => <div key={change.accountId}><strong>{change.accountName}</strong><span>{change.previousBalance === null ? 'New account' : formatSyncCredits(change.previousBalance)} <b aria-hidden="true">→</b> {formatSyncCredits(change.nextBalance)}</span></div>)}</div>}
      {review.preview.conflicts.length > 0 && <div className="sync-conflict-list"><h3>Primary values are kept on conflicts</h3>{review.preview.conflicts.map((conflict, index) => <p key={`${index}-${conflict}`}>{conflict}</p>)}</div>}
      <div className="clear-ledger-content"><p>Accepting applies this merge on the primary device. Incoming Game.log purchases and sales remain pending for account assignment.</p></div>
      <div className="record-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="button" onClick={onApply}>Apply merge</button></div>
    </section>
  </div>
}
