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
  onCancel,
  onConfirm,
  pageCount,
}: FolderDeleteDialogProps) {
  return (
    <AlertDialog onOpenChange={(open) => !open && onCancel()} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &quot;{folderName}&quot;?</AlertDialogTitle>
          <AlertDialogDescription>
            {pageCount} {pageCount === 1 ? "page" : "pages"} inside will also be deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Delete folder</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
