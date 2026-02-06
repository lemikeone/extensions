import {
  Action,
  ActionPanel,
  BrowserExtension,
  Detail,
  Form,
  environment,
  getPreferenceValues,
  getApplications,
  launchCommand,
  LaunchType,
  open,
  showHUD,
  showInFinder,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import path from "path";
import { extractBaseDomainFromUrl, extractDomainFromUrl, getFiltersForDomain, parseCssSelectors } from "./filters";
import { buildEpubBuffer, EpubResource } from "./epub";
import crypto from "crypto";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { sendEpubByEmail } from "./email";
import { SetupDeliveryModeForm } from "./setup-delivery-mode";
import { resolveSendPreferences, shouldShowSetupScreen } from "./settings";

type ViewState = {
  isLoading: boolean;
  title: string;
  markdownBody: string;
  author: string;
  pageUrl: string;
  sourceHtml: string;
  coverSelectors: string[];
};

type ArticleData = Omit<ViewState, "isLoading">;

type SendToKindleCommandProps = {
  autoSend?: boolean;
};

export default async function Command() {
  const preferences = await resolveSendPreferences();
  if (shouldShowSetupScreen(preferences)) {
    await launchCommand({ name: "set-change-sending-method", type: LaunchType.UserInitiated });
    return;
  }

  try {
    const article = await loadArticle();
    await sendArticle(article, { direct: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await showToast({
      style: Toast.Style.Failure,
      title: "Unable to send",
      message,
    });
  }
}

export function SendToKindleCommand({ autoSend = false }: SendToKindleCommandProps) {
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);
  const [state, setState] = useState<ViewState>({
    isLoading: true,
    title: "Reading",
    markdownBody: "",
    author: "",
    pageUrl: "",
    sourceHtml: "",
    coverSelectors: [],
  });

  useEffect(() => {
    let isMounted = true;

    async function checkSetupRequirement() {
      const preferences = await resolveSendPreferences();
      if (!isMounted) return;
      setNeedsOnboarding(shouldShowSetupScreen(preferences));
    }

    checkSetupRequirement();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (needsOnboarding !== false) return;

    let isMounted = true;

    async function run() {
      try {
        const article = await loadArticle();
        if (!isMounted) return;
        setState({
          isLoading: false,
          ...article,
        });
        if (autoSend) {
          await sendArticle(article, { direct: true });
        }
      } catch (error) {
        if (!isMounted) return;
        const message = error instanceof Error ? error.message : String(error);
        await showToast({
          style: Toast.Style.Failure,
          title: "Unable to load page",
          message,
        });
        setState({
          isLoading: false,
          title: "Error",
          markdownBody: message,
          author: "",
          pageUrl: "",
          sourceHtml: "",
          coverSelectors: [],
        });
      }
    }

    run();

    return () => {
      isMounted = false;
    };
  }, [autoSend, needsOnboarding]);

  if (needsOnboarding === null) {
    return <Detail isLoading markdown="Loading setup..." navigationTitle="Send to Kindle" />;
  }

  if (needsOnboarding) {
    return <SetupDeliveryModeForm onCompleted={() => setNeedsOnboarding(false)} />;
  }

  async function handleSend() {
    try {
      await sendArticle(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Unable to send",
        message,
      });
    }
  }

  const markdown = buildMarkdown(state.title, state.markdownBody, { includeTitle: true });

  return (
    <Detail
      markdown={markdown}
      isLoading={state.isLoading}
      navigationTitle={state.title}
      actions={
        <ActionPanel>
          <Action title="Send to Kindle" onAction={() => handleSend()} />
          {!autoSend && (
            <Action.Push
              title="Edit Content"
              shortcut={{ modifiers: ["cmd"], key: "e" }}
              target={
                <EditArticleForm
                  title={state.title}
                  markdownBody={state.markdownBody}
                  onSave={({ title, markdownBody }) => {
                    setState((previous) => ({
                      ...previous,
                      title,
                      markdownBody,
                    }));
                  }}
                />
              }
            />
          )}
          <Action title="Reveal Output Folder" onAction={() => showInFinder(environment.supportPath)} />
        </ActionPanel>
      }
    />
  );
}

async function loadArticle(): Promise<ArticleData> {
  if (!environment.canAccess(BrowserExtension)) {
    throw new Error("Raycast browser extension is not available.");
  }

  const tabs = await BrowserExtension.getTabs();
  const activeTab = tabs.find((tab) => tab.active) ?? tabs[0];

  const html = await BrowserExtension.getContent({
    format: "html",
    tabId: activeTab?.id,
  });

  const { document } = parseHTML(html);
  const pageUrl = activeTab?.url ?? "https://example.com";

  try {
    (document as unknown as { URL?: string }).URL = pageUrl;
    (document as unknown as { baseURI?: string }).baseURI = pageUrl;
  } catch {
    // Best-effort only; Readability can still parse without these.
  }

  const domain = extractDomainFromUrl(pageUrl);
  const sourceDomain = extractBaseDomainFromUrl(pageUrl);
  const coverSelectorList: string[] = [];
  const seenCoverSelectors = new Set<string>();
  if (domain) {
    const filters = await getFiltersForDomain(domain);
    const invalidSelectors: string[] = [];

    for (const filter of filters) {
      const coverSelectors = parseCssSelectors(filter.coverSelector);
      for (const coverSelector of coverSelectors) {
        if (seenCoverSelectors.has(coverSelector)) continue;
        seenCoverSelectors.add(coverSelector);
        coverSelectorList.push(coverSelector);
      }

      if (!filter.selector.trim()) {
        continue;
      }

      try {
        const matches = Array.from(document.querySelectorAll(filter.selector)) as Array<{ remove?: () => void }>;
        matches.forEach((element) => element.remove?.());
      } catch {
        invalidSelectors.push(filter.selector);
      }
    }

    if (invalidSelectors.length > 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Invalid CSS filters",
        message: `${invalidSelectors.length} filter(s) ignored.`,
      });
    }
  }

  const reader = new Readability(document);
  const article = reader.parse();

  if (!article?.content) {
    throw new Error("Readability could not extract readable content.");
  }

  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  return {
    title: article.title?.trim() || activeTab?.title || "Reading",
    markdownBody: turndownService.turndown(article.content),
    author: sourceDomain || domain || "",
    pageUrl,
    sourceHtml: html,
    coverSelectors: coverSelectorList,
  };
}

async function sendArticle(inputState: ArticleData, options?: { direct?: boolean }) {
  if (!inputState.markdownBody.trim()) {
    throw new Error("No content to send.");
  }

  const preferences = await resolveSendPreferences();
  const sendMethod = preferences.sendMethod ?? "app";
  const extensionPreferences = getPreferenceValues<{ shareEpubCover?: boolean; disableArticleLinks?: boolean }>();
  const shareEpubCover = extensionPreferences.shareEpubCover !== false;
  const disableArticleLinks = extensionPreferences.disableArticleLinks === true;
  const includeTitleInMarkdown = sendMethod !== "email";
  const includeTitleInEpub = !includeTitleInMarkdown;
  const markdown = buildMarkdown(inputState.title, inputState.markdownBody, { includeTitle: includeTitleInMarkdown });

  const progressToast = await showToast({
    style: Toast.Style.Animated,
    title: "Preparing Your Kindle Delivery",
    message: "Building EPUB and embedding images...",
  });

  let articleHtml = markdownToHtml(markdown);
  if (disableArticleLinks) {
    articleHtml = stripLinksFromHtml(articleHtml);
  }
  const { html, resources, warnings, coverResource, invalidCoverSelectors } = await inlineImages({
    html: articleHtml,
    pageUrl: inputState.pageUrl,
    sourceHtml: inputState.sourceHtml,
    coverSelectors: shareEpubCover ? inputState.coverSelectors : [],
    allowCoverResource: shareEpubCover,
  });

  if (warnings.length > 0) {
    progressToast.message = `${warnings.length} image(s) ignored.`;
  }
  if (invalidCoverSelectors.length > 0) {
    progressToast.message = `${invalidCoverSelectors.length} cover selector(s) ignored.`;
  }

  const epubBuffer = await buildEpubBuffer({
    title: inputState.title,
    author: inputState.author,
    language: "fr",
    bodyHtml: html,
    resources,
    coverResource,
    includeTitleInContent: includeTitleInEpub,
  });

  const safeTitle = sanitizeFilename(inputState.title) || "Article";
  const fileName = `${safeTitle}.epub`;
  await mkdir(environment.supportPath, { recursive: true });
  const filePath = path.join(environment.supportPath, fileName);
  await writeFile(filePath, epubBuffer);

  if (sendMethod === "email") {
    progressToast.title = "Delivering to Kindle Inbox";
    progressToast.message = "Sending email...";
    await sendEpubByEmail({
      title: inputState.title,
      filename: fileName,
      epubBuffer,
      preferences,
    });
    await deleteGeneratedEpub(filePath);

    if (options?.direct) {
      await showHUD("Delivered to Kindle Inbox");
      return;
    }
    progressToast.style = Toast.Style.Success;
    progressToast.title = "File Sent by Email";
    progressToast.message = "";
    return;
  }

  progressToast.title = "Opening Send to Kindle";
  progressToast.message = "Transferring EPUB...";
  const opened = await openWithSendToKindle(filePath);
  if (!opened) {
    progressToast.style = Toast.Style.Failure;
    progressToast.title = "Send to Kindle App Not Found";
    progressToast.message = "Install the Amazon app or open the file manually.";
    return;
  }
  await deleteGeneratedEpub(filePath);

  if (options?.direct) {
    await showHUD("Delivered to Send to Kindle");
    return;
  }

  progressToast.style = Toast.Style.Success;
  progressToast.title = "File Sent to Send to Kindle";
  progressToast.message = "";
}

async function deleteGeneratedEpub(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Do not fail delivery when local cleanup fails.
  }
}

type EditArticleFormProps = {
  title: string;
  markdownBody: string;
  onSave: (next: { title: string; markdownBody: string }) => void;
};

function EditArticleForm({ title, markdownBody, onSave }: EditArticleFormProps) {
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftBody, setDraftBody] = useState(markdownBody);
  const { pop } = useNavigation();

  return (
    <Form
      navigationTitle="Edit article"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save"
            onSubmit={() => {
              const normalizedTitle = draftTitle.trim() || "Reading";
              onSave({
                title: normalizedTitle,
                markdownBody: draftBody.trim(),
              });
              pop();
            }}
          />
          <Action title="Cancel" onAction={pop} />
        </ActionPanel>
      }
    >
      <Form.TextField id="title" title="Title" value={draftTitle} onChange={setDraftTitle} />
      <Form.TextArea id="content" title="Content (Markdown)" value={draftBody} onChange={setDraftBody} />
    </Form>
  );
}

type InlineImagesResult = {
  html: string;
  resources: EpubResource[];
  warnings: string[];
  coverResource?: EpubResource;
  invalidCoverSelectors: string[];
};

type InlineImagesInput = {
  html: string;
  pageUrl: string;
  sourceHtml?: string;
  coverSelectors?: string[];
  allowCoverResource?: boolean;
};

type FetchResponse = {
  ok: boolean;
  headers: { get: (name: string) => string | null };
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type Fetcher = (input: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponse>;

type ImageElementLike = {
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  tagName?: string;
  querySelector?: (selector: string) => unknown;
};

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);
const INPUT_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MIME_EXTENSION_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
};
const COVER_MAX_WIDTH = 1600;
const COVER_MAX_HEIGHT = 2560;

async function inlineImages({
  html,
  pageUrl,
  sourceHtml,
  coverSelectors = [],
  allowCoverResource = true,
}: InlineImagesInput): Promise<InlineImagesResult> {
  if (!html.trim()) {
    return { html, resources: [], warnings: [], invalidCoverSelectors: [] };
  }

  const baseUrl = pageUrl || "https://example.com";
  const { document } = parseHTML(`<article>${html}</article>`);
  const article = document.querySelector("article");
  if (!article) {
    return { html, resources: [], warnings: [], invalidCoverSelectors: [] };
  }

  const coverLookup = allowCoverResource
    ? await pickCoverFromSelectors({
        sourceHtml,
        pageUrl: baseUrl,
        selectors: coverSelectors,
      })
    : { invalidSelectors: [] };

  const imageElements = Array.from(article.querySelectorAll("img")) as ImageElementLike[];
  if (imageElements.length === 0) {
    return {
      html,
      resources: [],
      warnings: [],
      coverResource: coverLookup.coverResource,
      invalidCoverSelectors: coverLookup.invalidSelectors,
    };
  }

  const resources: EpubResource[] = [];
  const warnings: string[] = [];
  const cache = new Map<string, EpubResource>();
  let counter = 1;
  let coverResource: EpubResource | undefined = coverLookup.coverResource;

  for (const img of imageElements) {
    const candidate = chooseImageUrl(img, baseUrl);
    if (!candidate) continue;

    try {
      let resource = cache.get(candidate);
      if (!resource) {
        const fetched = await fetchImage(candidate);
        if (!fetched) {
          warnings.push(candidate);
          continue;
        }

        if (!SUPPORTED_IMAGE_MIME_TYPES.has(fetched.mediaType)) {
          warnings.push(candidate);
          continue;
        }

        const extension = MIME_EXTENSION_MAP[fetched.mediaType] || "jpg";
        const hash = crypto.createHash("sha1").update(candidate).digest("hex").slice(0, 10);
        const href = `images/image-${counter}-${hash}.${extension}`;
        const id = `img-${counter}-${hash}`;
        counter += 1;

        resource = {
          id,
          href,
          mediaType: fetched.mediaType,
          data: fetched.data,
        };
        cache.set(candidate, resource);
        resources.push(resource);
      }

      img.setAttribute("src", resource.href);
      img.removeAttribute("srcset");
      img.removeAttribute("data-srcset");
      img.removeAttribute("data-src");
      img.removeAttribute("data-original");
      img.removeAttribute("data-lazy-src");
      img.removeAttribute("data-actualsrc");

      if (allowCoverResource && !coverResource) {
        const coverData = await resizeImageForCover(resource.data, resource.mediaType);
        const coverExtension = MIME_EXTENSION_MAP[resource.mediaType] || "jpg";
        const coverHash = crypto.createHash("sha1").update(candidate).digest("hex").slice(0, 10);
        coverResource = {
          id: "cover-image",
          href: `images/cover-${coverHash}.${coverExtension}`,
          mediaType: resource.mediaType,
          data: coverData ?? resource.data,
          properties: "cover-image",
        };
      }
    } catch {
      warnings.push(candidate);
    }
  }

  const updatedHtml = article.innerHTML;
  return {
    html: updatedHtml,
    resources,
    warnings,
    coverResource,
    invalidCoverSelectors: coverLookup.invalidSelectors,
  };
}

function chooseImageUrl(element: { getAttribute: (name: string) => string | null }, pageUrl: string): string | null {
  const candidates: string[] = [];

  const src = element.getAttribute("src");
  if (src) candidates.push(src);

  const dataSrc = element.getAttribute("data-src");
  if (dataSrc) candidates.push(dataSrc);

  const dataOriginal = element.getAttribute("data-original");
  if (dataOriginal) candidates.push(dataOriginal);

  const dataLazy = element.getAttribute("data-lazy-src");
  if (dataLazy) candidates.push(dataLazy);

  const dataActual = element.getAttribute("data-actualsrc");
  if (dataActual) candidates.push(dataActual);

  const srcset = element.getAttribute("srcset") || element.getAttribute("data-srcset");
  if (srcset) {
    const srcsetCandidates = parseSrcset(srcset);
    candidates.push(...srcsetCandidates);
  }

  const cleaned = candidates.map((candidate) => candidate.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;

  const preferred = cleaned.find((candidate) => hasSupportedExtension(candidate));
  const chosen = preferred ?? cleaned[cleaned.length - 1];

  try {
    if (chosen.startsWith("data:")) return chosen;
    return new URL(chosen, pageUrl).toString();
  } catch {
    return null;
  }
}

type CoverFromSelectorsInput = {
  sourceHtml?: string;
  pageUrl: string;
  selectors: string[];
};

type CoverFromSelectorsResult = {
  coverResource?: EpubResource;
  invalidSelectors: string[];
};

async function pickCoverFromSelectors({
  sourceHtml,
  pageUrl,
  selectors,
}: CoverFromSelectorsInput): Promise<CoverFromSelectorsResult> {
  if (!sourceHtml?.trim() || selectors.length === 0) {
    return { invalidSelectors: [] };
  }

  const { document } = parseHTML(sourceHtml);
  const invalidSelectors: string[] = [];

  for (const selector of selectors) {
    let matches: Element[] = [];
    try {
      matches = Array.from(document.querySelectorAll(selector));
    } catch {
      invalidSelectors.push(selector);
      continue;
    }

    for (const match of matches) {
      const imageElement = findImageElement(match);
      if (!imageElement) continue;

      const candidate = chooseImageUrl(imageElement, pageUrl);
      if (!candidate) continue;

      try {
        const fetched = await fetchImage(candidate);
        if (!fetched || !SUPPORTED_IMAGE_MIME_TYPES.has(fetched.mediaType)) {
          continue;
        }

        const coverData = await resizeImageForCover(fetched.data, fetched.mediaType);
        const coverExtension = MIME_EXTENSION_MAP[fetched.mediaType] || "jpg";
        const coverHash = crypto.createHash("sha1").update(candidate).digest("hex").slice(0, 10);
        return {
          coverResource: {
            id: "cover-image",
            href: `images/cover-${coverHash}.${coverExtension}`,
            mediaType: fetched.mediaType,
            data: coverData ?? fetched.data,
            properties: "cover-image",
          },
          invalidSelectors,
        };
      } catch {
        // Keep scanning with next candidates.
      }
    }
  }

  return { invalidSelectors };
}

function isImageElementLike(value: unknown): value is ImageElementLike {
  if (!value || typeof value !== "object") return false;
  const element = value as Partial<ImageElementLike>;
  return (
    typeof element.getAttribute === "function" &&
    typeof element.setAttribute === "function" &&
    typeof element.removeAttribute === "function"
  );
}

function findImageElement(element: unknown): ImageElementLike | null {
  if (!element || typeof element !== "object") return null;
  const node = element as ImageElementLike;
  const tagName = typeof node.tagName === "string" ? node.tagName.toLowerCase() : "";
  if (tagName === "img" && isImageElementLike(node)) {
    return node;
  }

  const nested = typeof node.querySelector === "function" ? node.querySelector("img") : null;
  return isImageElementLike(nested) ? nested : null;
}

function parseSrcset(srcset: string): string[] {
  return srcset
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function hasSupportedExtension(candidate: string): boolean {
  try {
    if (candidate.startsWith("data:")) return false;
    const url = new URL(candidate, "https://example.com");
    const extension = path.extname(url.pathname).toLowerCase();
    return [".jpg", ".jpeg", ".png", ".gif"].includes(extension);
  } catch {
    return false;
  }
}

async function fetchImage(url: string): Promise<{ data: Buffer; mediaType: string } | null> {
  if (url.startsWith("data:")) {
    const decoded = decodeDataUri(url);
    if (!decoded) return null;
    return normalizeImage(decoded.data, decoded.mediaType);
  }

  const fetcher = (globalThis as unknown as { fetch?: Fetcher }).fetch;
  if (!fetcher) return null;

  const response = await fetcher(url, {
    headers: {
      Accept: "image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.5",
    },
  });

  if (!response.ok) return null;
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!contentType?.startsWith("image/")) return null;
  if (!INPUT_IMAGE_MIME_TYPES.has(contentType)) return null;

  const arrayBuffer = await response.arrayBuffer();
  const data = Buffer.from(arrayBuffer);
  return normalizeImage(data, contentType);
}

function decodeDataUri(dataUri: string): { data: Buffer; mediaType: string } | null {
  const match = dataUri.match(/^data:([^;,]+)?(;base64)?,/i);
  if (!match) return null;
  const mediaType = match[1]?.toLowerCase() || "image/png";
  if (!INPUT_IMAGE_MIME_TYPES.has(mediaType)) return null;
  const isBase64 = Boolean(match[2]);
  const dataPart = dataUri.slice(match[0].length);
  try {
    const buffer = isBase64 ? Buffer.from(dataPart, "base64") : Buffer.from(decodeURIComponent(dataPart));
    return { data: buffer, mediaType };
  } catch {
    return null;
  }
}

async function normalizeImage(data: Buffer, mediaType: string): Promise<{ data: Buffer; mediaType: string } | null> {
  if (mediaType === "image/webp") {
    const converted = await convertWebpToJpegWithSips(data);
    if (!converted) return null;
    return { data: converted, mediaType: "image/jpeg" };
  }

  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mediaType)) return null;
  return { data, mediaType };
}

const execFileAsync = promisify(execFile);

async function convertWebpToJpegWithSips(data: Buffer): Promise<Buffer | null> {
  if (process.platform !== "darwin") return null;

  const tempDir = path.join(os.tmpdir(), "send-to-kindle-images");
  await mkdir(tempDir, { recursive: true });
  const token = crypto.randomUUID();
  const inputPath = path.join(tempDir, `image-${token}.webp`);
  const outputPath = path.join(tempDir, `image-${token}.jpg`);

  try {
    await writeFile(inputPath, data);
    await execFileAsync("sips", ["-s", "format", "jpeg", inputPath, "--out", outputPath]);
    return await readFile(outputPath);
  } catch {
    return null;
  }
}

async function resizeImageForCover(data: Buffer, mediaType: string): Promise<Buffer | null> {
  if (process.platform !== "darwin") return null;

  const tempDir = path.join(os.tmpdir(), "send-to-kindle-cover");
  await mkdir(tempDir, { recursive: true });
  const token = crypto.randomUUID();
  const extension = MIME_EXTENSION_MAP[mediaType] || "jpg";
  const inputPath = path.join(tempDir, `cover-${token}.${extension}`);
  const resizedPath = path.join(tempDir, `cover-${token}-resized.${extension}`);
  const outputPath = path.join(tempDir, `cover-${token}-cropped.${extension}`);

  try {
    await writeFile(inputPath, data);
    const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", inputPath]);
    const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/i);
    const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/i);
    const width = widthMatch ? Number(widthMatch[1]) : NaN;
    const height = heightMatch ? Number(heightMatch[1]) : NaN;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }

    const scale = Math.max(COVER_MAX_WIDTH / width, COVER_MAX_HEIGHT / height, 1);
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    await execFileAsync("sips", ["-z", String(targetHeight), String(targetWidth), inputPath, "--out", resizedPath]);
    await execFileAsync("sips", [
      "-c",
      String(COVER_MAX_HEIGHT),
      String(COVER_MAX_WIDTH),
      resizedPath,
      "--out",
      outputPath,
    ]);
    return await readFile(outputPath);
  } catch {
    return null;
  }
}

function sanitizeFilename(input: string): string {
  return input
    .trim()
    .replace(/[\\/:*?"<>|]+/g, " ")
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function buildMarkdown(title: string, markdownBody: string, options?: { includeTitle?: boolean }): string {
  const safeTitle = title.trim() || "Reading";
  const normalizedTitle = safeTitle.replace(/\\\[/g, "(").replace(/\\\]/g, ")");
  const body = markdownBody.trim().replace(/\\\[/g, "(").replace(/\\\]/g, ")");
  const includeTitle = options?.includeTitle ?? true;
  if (!body) return includeTitle ? `# ${normalizedTitle}` : "";
  return includeTitle ? `# ${normalizedTitle}\n\n${body}` : body;
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let inCodeBlock = false;
  let codeFence = "";
  let codeLines: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = inlineMarkdownToHtml(paragraph.join(" ").trim());
    if (text) html.push(`<p>${text}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  };

  const openList = (type: "ul" | "ol") => {
    if (listType === type) return;
    closeList();
    html.push(`<${type}>`);
    listType = type;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        const code = escapeHtml(codeLines.join("\n"));
        const langClass = codeFence ? ` class="language-${escapeHtml(codeFence)}"` : "";
        html.push(`<pre><code${langClass}>${code}</code></pre>`);
        inCodeBlock = false;
        codeFence = "";
        codeLines = [];
      } else {
        flushParagraph();
        closeList();
        inCodeBlock = true;
        codeFence = trimmed.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = headingMatch[1].length;
      const content = inlineMarkdownToHtml(headingMatch[2].trim());
      html.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      openList("ul");
      html.push(`<li>${inlineMarkdownToHtml(unorderedMatch[1].trim())}</li>`);
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      openList("ol");
      html.push(`<li>${inlineMarkdownToHtml(orderedMatch[1].trim())}</li>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  if (inCodeBlock) {
    const code = escapeHtml(codeLines.join("\n"));
    html.push(`<pre><code>${code}</code></pre>`);
  }

  flushParagraph();
  closeList();

  return html.join("\n");
}

function stripLinksFromHtml(html: string): string {
  if (!html.trim()) return html;

  const { document } = parseHTML(`<article>${html}</article>`);
  const article = document.querySelector("article");
  if (!article) return html;

  const anchors = Array.from(article.querySelectorAll("a")) as Array<{
    firstChild: unknown;
    parentNode?: {
      insertBefore: (node: unknown, anchor: unknown) => void;
      removeChild: (node: unknown) => void;
    };
  }>;

  for (const anchor of anchors) {
    const parent = anchor.parentNode;
    if (!parent) continue;
    while (anchor.firstChild) {
      parent.insertBefore(anchor.firstChild, anchor);
    }
    parent.removeChild(anchor);
  }

  return article.innerHTML;
}

function inlineMarkdownToHtml(value: string): string {
  let output = escapeHtml(value);

  const codeSpans: string[] = [];
  output = output.replace(/`([^`]+)`/g, (_, code) => {
    const token = `\u0000CODE${codeSpans.length}\u0000`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });

  output = output.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    return `<img src="${url}" alt="${alt}" />`;
  });

  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    return `<a href="${url}">${applyInlineEmphasis(text)}</a>`;
  });

  output = applyInlineEmphasis(output);

  for (let i = 0; i < codeSpans.length; i += 1) {
    const token = `\u0000CODE${i}\u0000`;
    output = output.replace(token, codeSpans[i]);
  }

  return output;
}

function applyInlineEmphasis(value: string): string {
  let output = value;

  output = output.replace(/\*\*([^*]+)\*\*/g, (_, bold) => `<strong>${bold}</strong>`);
  output = output.replace(
    /(^|[^A-Za-z0-9])__(?=\S)([^_]*?\S)__([^A-Za-z0-9]|$)/g,
    (_, pre, bold, post) => `${pre}<strong>${bold}</strong>${post}`,
  );
  output = output.replace(/\*([^*]+)\*/g, (_, italic) => `<em>${italic}</em>`);
  output = output.replace(
    /(^|[^A-Za-z0-9])_(?=\S)([^_]*?\S)_([^A-Za-z0-9]|$)/g,
    (_, pre, italic, post) => `${pre}<em>${italic}</em>${post}`,
  );

  return output;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function openWithSendToKindle(filePath: string): Promise<boolean> {
  try {
    await open(filePath, "Send to Kindle");
    return true;
  } catch {
    // Fall back to finding an app by name that can open .epub
  }

  try {
    const apps = await getApplications(filePath);
    const app = apps.find((candidate) => candidate.name.toLowerCase().includes("send to kindle"));
    if (!app) return false;
    await open(filePath, app);
    return true;
  } catch {
    return false;
  }
}
