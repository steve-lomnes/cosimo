import { useNavigate } from "@tanstack/react-router";
import { useOrgId, useRole } from "../lib/org";
import { setPendingReceiptFile } from "../lib/receipts";
import { cx } from "./ui";

/**
 * "Snap receipt": opens the file chooser, then the capture form with the file in hand. No `capture`
 * attribute, for the same reason as Attachments: the chooser offers "Take Photo" and still lets a PDF
 * be picked.
 */
export function SnapReceipt({ className }: { className?: string }) {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const navigate = useNavigate();
  if (!canWrite) return null;
  return (
    <label
      className={cx(
        "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-500 hover:bg-brand-700 touch:min-h-11",
        className,
      )}
    >
      Snap receipt
      <input
        type="file"
        className="sr-only"
        accept="image/*,application/pdf"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setPendingReceiptFile(f);
          navigate({ to: "/o/$orgId/banking/receipts/new", params: { orgId } } as never);
        }}
      />
    </label>
  );
}
