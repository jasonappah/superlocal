import { Icon, IconButton, Key, Modal } from "./components";

export type UnsubscribeMode = "unsubscribe" | "done" | "trash";

type UnsubscribeDialogProps = {
  sender: string;
  busy?: boolean;
  error?: string;
  onClose: () => void;
  onChoose: (mode: UnsubscribeMode) => void;
};

const options: Array<{ mode: UnsubscribeMode; label: string; detail: string; icon: string }> = [
  {
    mode: "unsubscribe",
    label: "Unsubscribe",
    detail: "Stop future email from this sender",
    icon: "Envelope",
  },
  {
    mode: "done",
    label: "Unsubscribe, and Mark Done all",
    detail: "Unsubscribe, then mark every conversation from this sender as Done",
    icon: "Check",
  },
  {
    mode: "trash",
    label: "Unsubscribe, and Trash all",
    detail: "Unsubscribe, then move every conversation from this sender to Trash",
    icon: "CaretsOut",
  },
];

/** The ⌘U menu, matching Superhuman's three unsubscribe choices. */
export default function UnsubscribeDialog({ sender, busy = false, error, onClose, onChoose }: UnsubscribeDialogProps) {
  return (
    <Modal
      label="Unsubscribe"
      className="command-modal unsubscribe-modal"
      initialFocus="dialog"
      onClose={() => { if (!busy) onClose(); }}
    >
      <div className="command-header">
        <span>Unsubscribe from {sender}</span>
        <IconButton name="Close" title="Close" disabled={busy} onClick={onClose} />
      </div>
      <div className="command-results" role="listbox" aria-label="Unsubscribe options" aria-busy={busy}>
        {options.map((option, index) => (
          <button
            key={option.mode}
            type="button"
            role="option"
            aria-selected={false}
            className="command-option"
            disabled={busy}
            onClick={() => onChoose(option.mode)}
          >
            <span className="icon"><Icon name={option.icon} /></span>
            <span>{option.label}<small>{option.detail}</small></span>
            {index === 0 && <Key>⌘U</Key>}
          </button>
        ))}
      </div>
      {error
        ? <p className="unsubscribe-error" role="alert">{error}</p>
        : <p className="unsubscribe-note">Superlocal uses the sender&rsquo;s own unsubscribe request. Nothing is sent when a sender does not advertise one.</p>}
    </Modal>
  );
}
