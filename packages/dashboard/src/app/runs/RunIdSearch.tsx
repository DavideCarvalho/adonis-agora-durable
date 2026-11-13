import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { durableClient } from '../../client/durable-client';
import { SearchIcon } from '../icons';
import { InputField } from '../ui/input';

/**
 * Header search: jump straight to a run by id (`GET /runs/:id`). On a hit it navigates to the run's
 * detail through the SAME hash-based mechanism a list click uses; a miss says so inline instead of
 * silently doing nothing — an operator pasting an id from a log needs the "it does not exist here"
 * answer as much as the run itself.
 */
export function RunIdSearch({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const [draft, setDraft] = useState('');
  const [missing, setMissing] = useState(false);
  const lookup = useMutation({
    mutationFn: (id: string) => durableClient.run(id),
    onSuccess: (detail) => {
      setDraft('');
      setMissing(false);
      onOpenRun(detail.run.id);
    },
    // Any failure reads as "not found": the only errors `GET /runs/:id` answers are the 404 and
    // the 401 the client already turns into a login redirect before this handler runs.
    onError: () => setMissing(true),
  });
  return (
    <form
      className="relative"
      onSubmit={(e) => {
        e.preventDefault();
        const id = draft.trim();
        if (id) lookup.mutate(id);
      }}
    >
      <InputField
        glyph={<SearchIcon width={12} height={12} />}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setMissing(false);
        }}
        onClear={() => {
          setDraft('');
          setMissing(false);
        }}
        clearLabel="clear run id"
        placeholder="open run id…"
        aria-label="open run by id"
        containerClassName="w-44"
      />
      {missing && (
        <span className="mono absolute left-0 top-full z-20 mt-1 whitespace-nowrap rounded border border-bad/25 bg-panel-2 px-1.5 py-0.5 text-[10px] text-bad">
          no run with that id
        </span>
      )}
    </form>
  );
}
