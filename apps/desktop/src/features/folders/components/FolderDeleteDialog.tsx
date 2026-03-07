import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface FolderDeleteDialogProps {
  folderName: string;
  pageCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function FolderDeleteDialog({
  folderName,
  pageCount,
  onConfirm,
  onCancel,
}: FolderDeleteDialogProps) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &quot;{folderName}&quot;?</AlertDialogTitle>
          <AlertDialogDescription>
            {pageCount} {pageCount === 1 ? "page" : "pages"} will be moved to Inbox. This cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Delete &amp; Move to Inbox</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
