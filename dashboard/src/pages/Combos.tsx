import { useEffect, useState } from "react";
import { GripVertical, Loader2, Plus, RefreshCw, Shuffle, Trash2, X } from "lucide-react";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/ui/PageHeader";
import { Alert } from "../components/ui/Alert";
import { EmptyState } from "../components/ui/EmptyState";
import {
  createCombo,
  deleteCombo,
  fetchCombos,
  fetchModels,
  updateCombo,
  type Combo,
  type ModelInfo,
} from "../lib/api";
import { cn } from "../lib/utils";
import { useTimedMessage } from "../hooks/useTimedMessage";

// Combos page — a combo is a named ordered list of provider/model strings.
// When a client sends the combo name as `model`, the router tries each entry
// in order until one succeeds. Turns "claude-opus first, glm-5.2 fallback"
// into a single stable address the client hardcodes.
export default function Combos() {
  const [rows, setRows] = useState<Combo[] | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { message, setMessage, clearMessage } = useTimedMessage<string | null>(null);

  // Add form state
  const [newName, setNewName] = useState("");
  const [newModels, setNewModels] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Inline edit state — one combo at a time
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editModels, setEditModels] = useState<string[]>([]);

  async function load() {
    try {
      const [c, m] = await Promise.all([fetchCombos(), fetchModels()]);
      setRows(c.data);
      setModels(m.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  function ok(text: string) {
    setMessage(text);
    setError(null);
  }
  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
    clearMessage();
  }

  const modelStrings = models.map((m) => `${m.owned_by}/${m.id}`).sort();

  async function handleAdd() {
    const name = newName.trim();
    if (!name || newModels.length < 2) return;
    setBusy(true);
    try {
      await createCombo({ name, models: newModels });
      setNewName("");
      setNewModels([]);
      ok(`Combo "${name}" created`);
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  function startEdit(row: Combo) {
    setEditingId(row.id);
    setEditName(row.name);
    setEditModels([...row.models]);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditModels([]);
  }

  async function handleSaveEdit(id: number) {
    if (!editName.trim() || editModels.length < 2) return;
    setBusy(true);
    try {
      await updateCombo(id, { name: editName.trim(), models: editModels });
      ok(`Combo updated`);
      cancelEdit();
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(row: Combo) {
    if (!confirm(`Delete combo "${row.name}"?`)) return;
    setBusy(true);
    try {
      await deleteCombo(row.id);
      ok(`Combo "${row.name}" deleted`);
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Shuffle}
        title="Combos"
        subtitle="Fallback chains — one client-facing name, N upstream models tried in order"
        actions={
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        }
      />

      {message && <Alert variant="success">{message}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}

      {/* Add form */}
      <Card className="p-4">
        <div className="mb-3 text-sm font-medium">Add combo</div>
        <div className="grid gap-3 md:grid-cols-[200px_1fr_auto]">
          <Input
            placeholder="combo name (e.g. smart-combo)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="font-mono text-xs"
          />
          <ModelListEditor
            models={newModels}
            available={modelStrings}
            onChange={setNewModels}
            picker={pickerOpen}
            setPicker={setPickerOpen}
          />
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={busy || !newName.trim() || newModels.length < 2}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add
          </Button>
        </div>
        {newName.trim() && newModels.length < 2 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Pick at least 2 models — a 1-model combo is just an alias.
          </p>
        )}
      </Card>

      {/* List */}
      <Card className="overflow-hidden">
        {rows == null ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Shuffle}
            title="No combos yet"
            hint="Add your first combo above — chain models so a client keeps working when the primary pool runs dry."
          />
        ) : (
          <table className="w-full">
            <thead className="border-b border-border bg-background text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Fallback chain</th>
                <th className="px-4 py-2.5 w-40">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.id} className="align-top">
                  {editingId === row.id ? (
                    <>
                      <td className="px-4 py-3">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="font-mono text-xs"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <ModelListEditor
                          models={editModels}
                          available={modelStrings}
                          onChange={setEditModels}
                          picker={false}
                          setPicker={() => {}}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            onClick={() => handleSaveEdit(row.id)}
                            disabled={busy || !editName.trim() || editModels.length < 2}
                          >
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={cancelEdit}>
                            Cancel
                          </Button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3">
                        <code className="rounded bg-secondary px-2 py-1 text-xs">{row.name}</code>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          {row.models.map((m, i) => (
                            <span key={i} className="inline-flex items-center gap-1.5">
                              <Badge variant="secondary">
                                {i + 1}. <span className="ml-1 font-mono">{m}</span>
                              </Badge>
                              {i < row.models.length - 1 && (
                                <span className="text-muted-foreground">→</span>
                              )}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <Button size="sm" variant="secondary" onClick={() => startEdit(row)}>
                            Edit
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Delete"
                            onClick={() => handleDelete(row)}
                            disabled={busy}
                          >
                            <Trash2 className="h-4 w-4 text-error" />
                          </Button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// Ordered model list with add-via-datalist + remove per entry. Order matters
// (index 0 = primary attempt), so a small drag handle hints at the shuffle
// affordance even if we're not full drag-drop yet.
function ModelListEditor({
  models,
  available,
  onChange,
  picker: _picker,
  setPicker: _setPicker,
}: {
  models: string[];
  available: string[];
  onChange: (next: string[]) => void;
  picker: boolean;
  setPicker: (v: boolean) => void;
}) {
  const [pending, setPending] = useState("");

  function add() {
    const s = pending.trim();
    if (!s) return;
    if (models.includes(s)) {
      setPending("");
      return;
    }
    onChange([...models, s]);
    setPending("");
  }

  function remove(i: number) {
    onChange(models.filter((_, idx) => idx !== i));
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= models.length) return;
    const next = [...models];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    onChange(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {models.map((m, i) => (
          <div
            key={i}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-mono"
            )}
          >
            <button
              onClick={() => move(i, i - 1)}
              disabled={i === 0}
              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              aria-label="Move up"
              title="Move earlier in fallback order"
            >
              <GripVertical className="h-3 w-3" />
            </button>
            <span className="text-muted-foreground">{i + 1}.</span>
            <span>{m}</span>
            <button
              onClick={() => remove(i)}
              className="text-muted-foreground hover:text-error"
              aria-label="Remove"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-1">
        <Input
          list="combo-model-options"
          placeholder="provider/model (e.g. codebuddy/claude-opus-4.7-1m)"
          value={pending}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          className="font-mono text-xs"
        />
        <Button size="sm" variant="secondary" onClick={add} disabled={!pending.trim()}>
          Add
        </Button>
      </div>
      <datalist id="combo-model-options">
        {available.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}
