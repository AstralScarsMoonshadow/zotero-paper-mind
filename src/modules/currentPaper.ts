declare const IOUtils: any;
declare const Zotero_Tabs: any;

export interface CurrentPaperText {
  text: string;
  source: string;
  itemKey?: string;
  title?: string;
}

async function getItemByID(id: number): Promise<any> {
  return await (Zotero as any).Items.getAsync(id);
}

async function getCurrentReaderItem(): Promise<any | null> {
  try {
    const selectedTabID = (globalThis as any).Zotero_Tabs?.selectedID ?? Zotero_Tabs?.selectedID;
    const reader = (Zotero as any).Reader?.getByTabID?.(selectedTabID);

    const itemID =
      reader?.itemID ??
      reader?._itemID ??
      reader?._instance?._itemID ??
      reader?._state?.itemID;

    if (!itemID) {
      return null;
    }

    return await getItemByID(itemID);
  } catch (_) {
    return null;
  }
}

function getSelectedLibraryItems(): any[] {
  try {
    const pane = (Zotero as any).getActiveZoteroPane?.();
    const items = pane?.getSelectedItems?.();
    return Array.isArray(items) ? items : [];
  } catch (_) {
    return [];
  }
}

async function resolveParentItem(item: any): Promise<any> {
  if (!item) {
    return null;
  }

  if (item.isAttachment?.() && item.parentItemID) {
    return await getItemByID(item.parentItemID);
  }

  return item;
}

function isPDFAttachment(item: any): boolean {
  if (!item?.isAttachment?.()) {
    return false;
  }

  const contentType =
    item.attachmentContentType ??
    item.getField?.("contentType") ??
    "";

  const filename =
    item.attachmentFilename ??
    item.getField?.("title") ??
    "";

  return (
    String(contentType).toLowerCase().includes("pdf") ||
    String(filename).toLowerCase().endsWith(".pdf")
  );
}

async function getPDFAttachmentsFromItem(item: any): Promise<any[]> {
  if (!item) {
    return [];
  }

  if (isPDFAttachment(item)) {
    return [item];
  }

  const attachmentIDs = item.getAttachments?.() ?? [];
  const attachments: any[] = [];

  for (const id of attachmentIDs) {
    const attachment = await getItemByID(id);
    if (isPDFAttachment(attachment)) {
      attachments.push(attachment);
    }
  }

  return attachments;
}

function getCachePathFromPDFPath(pdfPath: string): string {
  const sep = pdfPath.includes("\\") ? "\\" : "/";
  const dir = pdfPath.replace(/[\\/][^\\/]+$/, "");
  return `${dir}${sep}.zotero-ft-cache`;
}

async function readTextFile(path: string): Promise<string> {
  try {
    if (typeof IOUtils !== "undefined" && IOUtils?.readUTF8) {
      return await IOUtils.readUTF8(path);
    }
  } catch (_) {
    // fallback
  }

  try {
    const file = (Zotero as any).File;
    if (file?.getContentsAsync) {
      return await file.getContentsAsync(path);
    }
  } catch (_) {
    // fallback
  }

  return "";
}

async function readAttachmentFullTextCache(attachment: any): Promise<string> {
  const filePath = await attachment.getFilePathAsync?.();

  if (!filePath) {
    return "";
  }

  const cachePath = getCachePathFromPDFPath(filePath);
  const text = await readTextFile(cachePath);

  return typeof text === "string" ? text.trim() : "";
}

async function getCandidateItems(): Promise<any[]> {
  const candidates: any[] = [];

  const readerItem = await getCurrentReaderItem();
  if (readerItem) {
    candidates.push(readerItem);
  }

  const selectedItems = getSelectedLibraryItems();
  for (const item of selectedItems) {
    if (item && !candidates.some((x) => x.id === item.id)) {
      candidates.push(item);
    }
  }

  return candidates;
}

export async function getCurrentPaperText(): Promise<CurrentPaperText> {
  const candidates = await getCandidateItems();

  for (const candidate of candidates) {
    const parentItem = await resolveParentItem(candidate);
    const attachments = await getPDFAttachmentsFromItem(candidate);

    const parentAttachments =
      parentItem && parentItem.id !== candidate.id
        ? await getPDFAttachmentsFromItem(parentItem)
        : [];

    const allAttachments = [...attachments, ...parentAttachments];

    for (const attachment of allAttachments) {
      const text = await readAttachmentFullTextCache(attachment);

      if (text.length > 1000) {
        const title =
          parentItem?.getField?.("title") ??
          attachment?.getField?.("title") ??
          "Untitled";

        return {
          text,
          source: `Zotero full-text cache: ${title}`,
          itemKey: parentItem?.key ?? attachment?.key,
          title,
        };
      }
    }
  }

  throw new Error(
    "没有自动读取到当前论文全文。\n\n可能原因：\n1. 当前没有打开 PDF，也没有选中 Zotero 条目\n2. 当前条目没有 PDF 附件\n3. PDF 尚未被 Zotero 建立全文索引\n4. PDF 是扫描版，需要 OCR\n\n临时解决方法：继续使用 Analyze Full Paper from Clipboard。",
  );
}

export interface CurrentPaperIdentity {
  itemKey: string;
  title: string;
  itemID: number;
}

export async function getCurrentPaperIdentity(): Promise<CurrentPaperIdentity> {
  const candidates = await getCandidateItems();

  for (const candidate of candidates) {
    const parentItem = await resolveParentItem(candidate);
    const item = parentItem || candidate;

    if (!item?.key) {
      continue;
    }

    return {
      itemKey: item.key,
      title: item.getField?.("title") ?? "Untitled",
      itemID: item.id,
    };
  }

  throw new Error(
    "没有识别到当前 Zotero 论文。\n\n请打开一个 PDF，或者在 Zotero 文献列表中选中一篇有 PDF 附件的条目。",
  );
}

