/**
 * Zod schemas for data that crosses the browser boundary: CDP results and
 * values returned by in-page scripts. Only the fields UI DNA reads are
 * described; everything else is dropped.
 */
import { z } from 'zod';

const RareStringData = z.object({ index: z.array(z.number().int()), value: z.array(z.number().int()) });
const RareIntegerData = z.object({ index: z.array(z.number().int()), value: z.array(z.number().int()) });

/** `DOMSnapshot.NodeTreeSnapshot` (subset). */
export const NodeTreeSnapshotSchema = z.object({
  parentIndex: z.array(z.number().int()).optional(),
  nodeType: z.array(z.number().int()).optional(),
  nodeName: z.array(z.number().int()).optional(),
  nodeValue: z.array(z.number().int()).optional(),
  backendNodeId: z.array(z.number().int()).optional(),
  attributes: z.array(z.array(z.number().int())).optional(),
  shadowRootType: RareStringData.optional(),
  contentDocumentIndex: RareIntegerData.optional(),
  pseudoType: RareStringData.optional(),
  currentSourceURL: RareStringData.optional(),
});

/** `DOMSnapshot.LayoutTreeSnapshot` (subset). */
export const LayoutTreeSnapshotSchema = z.object({
  nodeIndex: z.array(z.number().int()),
  styles: z.array(z.array(z.number().int())),
  bounds: z.array(z.array(z.number())),
  text: z.array(z.number().int()).optional(),
});

/** `DOMSnapshot.DocumentSnapshot` (subset). */
export const DocumentSnapshotSchema = z.object({
  documentURL: z.number().int(),
  title: z.number().int(),
  nodes: NodeTreeSnapshotSchema,
  layout: LayoutTreeSnapshotSchema,
  scrollOffsetX: z.number().optional(),
  scrollOffsetY: z.number().optional(),
  contentWidth: z.number().optional(),
  contentHeight: z.number().optional(),
});

/** Result of `DOMSnapshot.captureSnapshot`. */
export const DomSnapshotResultSchema = z.object({
  documents: z.array(DocumentSnapshotSchema).min(1),
  strings: z.array(z.string()),
});
/** Parsed `DOMSnapshot.captureSnapshot` result. */
export type DomSnapshotResult = z.infer<typeof DomSnapshotResultSchema>;

const AxValueSchema = z.object({
  type: z.string(),
  value: z.unknown().optional(),
  relatedNodes: z.array(z.object({ backendDOMNodeId: z.number().int(), idref: z.string().optional(), text: z.string().optional() })).optional(),
});

/** `Accessibility.AXNode` (subset). */
export const AxNodeSchema = z.object({
  nodeId: z.string(),
  ignored: z.boolean(),
  role: AxValueSchema.optional(),
  name: AxValueSchema.optional(),
  description: AxValueSchema.optional(),
  properties: z.array(z.object({ name: z.string(), value: AxValueSchema })).optional(),
  backendDOMNodeId: z.number().int().optional(),
  parentId: z.string().optional(),
  childIds: z.array(z.string()).optional(),
});
/** Parsed accessibility node. */
export type AxNodeData = z.infer<typeof AxNodeSchema>;

/** Result of `Accessibility.getFullAXTree`. */
export const AxTreeResultSchema = z.object({ nodes: z.array(AxNodeSchema) });

/** Result of `DOM.getDocument` (recursive subset used to map backend ids to paths). */
export interface DomNodeData {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly backendNodeId: number;
  readonly children?: readonly DomNodeData[];
}
const DomNodeSchema: z.ZodType<DomNodeData> = z.lazy(() =>
  z.object({
    nodeType: z.number().int(),
    nodeName: z.string(),
    backendNodeId: z.number().int(),
    children: z.array(DomNodeSchema).optional(),
  }),
);
/** Result of `DOM.getDocument`. */
export const DomGetDocumentResultSchema = z.object({ root: DomNodeSchema });

/** Result of `CSS.getPlatformFontsForNode`. */
export const PlatformFontsResultSchema = z.object({
  fonts: z.array(z.object({ familyName: z.string(), postScriptName: z.string().optional(), isCustomFont: z.boolean(), glyphCount: z.number() })),
});

/** Result of `Browser.getVersion`. */
export const BrowserVersionResultSchema = z.object({ product: z.string(), userAgent: z.string() });

/** Result of `Target.getTargetInfo`. */
export const TargetInfoResultSchema = z.object({ targetInfo: z.object({ targetId: z.string(), type: z.string(), url: z.string() }) });

/** Body of `<endpoint>/json/version`. */
export const CdpVersionJsonSchema = z.object({ Browser: z.string().optional(), 'User-Agent': z.string().optional(), webSocketDebuggerUrl: z.string().optional() });

const BoxTuple = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const StyleRecord = z.record(z.string(), z.string());

/** One element produced by the in-page walk (fallback when DOMSnapshot is unavailable). */
export const WalkedElementSchema = z.object({
  parent: z.number().int().nullable(),
  childIndex: z.number().int().min(0),
  tag: z.string(),
  attrs: z.array(z.tuple([z.string(), z.string()])),
  text: z.string().nullable(),
  box: BoxTuple.nullable(),
  style: StyleRecord.nullable(),
  pseudo: z.object({
    before: z.object({ content: z.string(), style: StyleRecord }).optional(),
    after: z.object({ content: z.string(), style: StyleRecord }).optional(),
  }),
  currentSrc: z.string().nullable(),
  shadowRoot: z.enum(['open', 'closed']).nullable(),
  isFrame: z.boolean(),
});
/** Result of the in-page walk: elements in document order plus the document URL and title. */
export const WalkedTreeSchema = z.object({
  elements: z.array(WalkedElementSchema),
  url: z.string(),
  title: z.string(),
});

/** Result of the in-page document metrics script. */
export const DocumentMetricsSchema = z.object({
  width: z.number(),
  height: z.number(),
  scrollHeight: z.number(),
  innerWidth: z.number(),
  innerHeight: z.number(),
  url: z.string(),
  title: z.string(),
});

/** Result of the in-page style fill script: one filtered style per requested path (null when the path did not resolve). */
export const StyleFillResultSchema = z.array(StyleRecord.nullable());

/** Result of the in-page font script. */
export const FontFacesResultSchema = z.object({
  faces: z.array(z.object({ family: z.string(), weight: z.string(), style: z.string(), status: z.string() })),
  rules: z.array(z.object({ family: z.string(), weight: z.string(), style: z.string(), src: z.string() })),
  inaccessibleStyleSheets: z.number().int().min(0),
});

/** Result of the in-page image dimensions script. */
export const ImageSizesResultSchema = z.array(z.object({ width: z.number(), height: z.number() }).nullable());

/** Result of the in-page icon link script. */
export const IconLinksResultSchema = z.array(z.string());
