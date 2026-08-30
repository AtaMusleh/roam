"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { BlurhashCanvas } from "@/components/blurhash-canvas";
import { UNSPLASH_HOME, unsplashVariant } from "@/lib/unsplash";
import { cn } from "@/lib/utils";

export interface LightboxPhoto {
  id: string;
  url: string;
  width: number;
  height: number;
  blurhash: string | null;
  photographerName: string | null;
  photographerUrl: string | null;
}

export interface OpenLightboxOptions {
  /** The photographs to step through — one visit's worth. */
  photos: readonly LightboxPhoto[];
  /** Which one to show first. */
  index: number;
  /** Where the click came from; focus returns here on close. */
  origin: HTMLElement | null;
  /** Names the set, for the dialog's accessible label. */
  label: string;
}

type OpenLightbox = (options: OpenLightboxOptions) => void;

const LightboxContext = createContext<OpenLightbox | null>(null);

/**
 * Opens the lightbox. Available anywhere inside `LightboxProvider`.
 *
 * Returns a no-op outside one rather than throwing, so a photo grid can be
 * rendered somewhere without a lightbox — a print view, a test — without
 * having to know whether it is inside a provider.
 */
export function useLightbox(): OpenLightbox {
  const open = useContext(LightboxContext);
  return open ?? noop;
}

const noop: OpenLightbox = () => undefined;

/** Widest variant to request. Beyond this is more bytes than screen. */
const MAX_REQUEST_WIDTH = 2400;

/** How far a touch must travel before it counts as a swipe, in pixels. */
const SWIPE_NAVIGATE_PX = 60;
const SWIPE_DISMISS_PX = 110;

/** Every control clears the 44px minimum target size. */
const CONTROL = "flex size-11 items-center justify-center rounded-full";

function fullSizeUrl(photo: LightboxPhoto): string {
  return unsplashVariant(photo.url, MAX_REQUEST_WIDTH, photo.width);
}

interface Viewport {
  width: number;
  height: number;
}

/**
 * The size to draw a photograph at.
 *
 * Scales it down to fit the space and no further: `scale` is capped at 1, so a
 * small photograph sits at its own size in the middle of a large screen rather
 * than being blown up into mush. The aspect ratio is preserved by construction,
 * so nothing is ever cropped.
 */
function fitWithin(photo: LightboxPhoto, viewport: Viewport): Viewport | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;

  const scale = Math.min(
    viewport.width / photo.width,
    viewport.height / photo.height,
    1,
  );

  return {
    width: Math.round(photo.width * scale),
    height: Math.round(photo.height * scale),
  };
}

interface LightboxState extends OpenLightboxOptions {
  photos: readonly LightboxPhoto[];
}

function Lightbox({
  state,
  onClose,
}: {
  state: LightboxState;
  onClose: () => void;
}) {
  const { photos, label, origin } = state;

  const [index, setIndex] = useState(state.index);
  const [loaded, setLoaded] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);

  /**
   * The frame the photograph is fitted into, held in state rather than a ref.
   *
   * A ref plus an effect with empty dependencies does not work here: Radix
   * mounts a portal's children after the first commit, so the effect runs while
   * `ref.current` is still null, bails out, and — having no dependencies —
   * never runs again. The measurement stays at zero, no size is ever applied,
   * and the photograph lays out at the frame's full width with its height
   * following the aspect ratio, hanging off the bottom of the screen.
   *
   * A callback ref stored in state re-runs the effect the moment the node
   * appears, whenever that happens to be.
   */
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  /** Holds preloaded images so the browser does not discard them immediately. */
  const preloaded = useRef<HTMLImageElement[]>([]);

  const photo = photos[index];

  const go = useCallback(
    (delta: number) => {
      setIndex((current) => {
        const next = current + delta;
        if (next < 0 || next >= photos.length) return current;

        setLoaded(false);
        return next;
      });
    },
    [photos.length],
  );

  // --- the space available for the photograph ------------------------------
  //
  // The frame is absolutely positioned, so its size comes from its insets
  // alone. Measuring anything the photograph sits inside of would let the
  // photograph influence the number it is being sized by.

  useEffect(() => {
    if (!stage) return;

    const measure = (): void => {
      setViewport({ width: stage.clientWidth, height: stage.clientHeight });
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(stage);

    return () => {
      observer.disconnect();
    };
  }, [stage]);

  // --- keyboard -------------------------------------------------------------
  //
  // Escape is Radix's; the arrows are ours. Bound to the document rather than
  // the dialog so they work wherever focus happens to be inside it.

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        go(1);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [go]);

  // --- preload the neighbours ----------------------------------------------
  //
  // Without this, every step through a visit shows a blurhash and then a
  // photograph. With it the next one is usually already decoded and appears at
  // once, which is the difference between browsing and waiting.

  useEffect(() => {
    const neighbours = [photos[index - 1], photos[index + 1]].filter(
      (candidate): candidate is LightboxPhoto => candidate !== undefined,
    );

    preloaded.current = neighbours.map((neighbour) => {
      const image = new window.Image();
      image.src = fullSizeUrl(neighbour);
      return image;
    });
  }, [index, photos]);

  // --- swipe ----------------------------------------------------------------

  const endDrag = useCallback(
    (dx: number, dy: number) => {
      setDrag(null);

      // Whichever axis moved further decides what the gesture meant.
      if (Math.abs(dx) > Math.abs(dy)) {
        if (Math.abs(dx) >= SWIPE_NAVIGATE_PX) go(dx < 0 ? 1 : -1);
        return;
      }

      // Downward only: dragging a photograph off the bottom is the usual way
      // to dismiss one, and dragging up means nothing here.
      if (dy >= SWIPE_DISMISS_PX) onClose();
    },
    [go, onClose],
  );

  if (!photo) return null;

  const size = fitWithin(photo, viewport);
  const source = fullSizeUrl(photo);

  const dismissProgress =
    drag !== null && drag.y > 0 && Math.abs(drag.y) > Math.abs(drag.x)
      ? Math.min(drag.y / (SWIPE_DISMISS_PX * 2), 0.6)
      : 0;

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        {/*
          `dark` is repeated on both parts. They render through a portal to
          document.body, outside the element the trip view scopes the dark
          theme to, so without it the chrome comes up in light colours.

          The backdrop is fully opaque. A photograph is being looked at on its
          own terms here, and even a tenth of the trip page glowing through the
          margins competes with it — on a phone, where a landscape photograph
          fills a band across the middle, the rest of the screen is nearly all
          margin.
        */}
        <DialogPrimitive.Overlay className="dark fixed inset-0 z-50 bg-black animate-in fade-in duration-200 ease-out" />

        <DialogPrimitive.Content
          aria-label={`Photographs from ${label}`}
          // Radix marks the app's own nodes `aria-hidden` while a modal is
          // open, but not every sibling of `body` — and `aria-modal` is the
          // attribute assistive technology actually looks for to know the rest
          // of the page is unreachable. Stating it costs nothing.
          aria-modal="true"
          className="dark fixed inset-0 z-50 flex flex-col outline-none"
          onCloseAutoFocus={(event) => {
            // Radix would return focus to whatever was focused when the dialog
            // opened. That is usually the right element, but a click does not
            // focus a button in every browser, so put it back explicitly.
            event.preventDefault();
            origin?.focus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {`Photographs from ${label}`}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Use the left and right arrow keys to move between photographs, and
            Escape to close.
          </DialogPrimitive.Description>

          {/*
            The backdrop is its own layer beneath everything else, so a click
            anywhere that is not the photograph or a control lands on it. That
            is simpler and more predictable than asking, of each click, whether
            it happened to miss the content.
          */}
          <button
            type="button"
            // Hidden from assistive technology and from the tab order: it is a
            // convenience for pointers, and announcing a second "Close" button
            // covering the whole screen would only be in the way. Keyboard and
            // screen-reader users have Escape and the close button in the
            // corner.
            aria-hidden
            tabIndex={-1}
            onClick={onClose}
            className="absolute inset-0 cursor-default"
          />

          {/*
            Header and footer sit above the stage. They come before and after it
            in the flow, so at an equal z-index the photograph paints over the
            header — which is what was clipping the counter behind the image.
          */}
          <header className="pointer-events-none relative z-20 flex items-center justify-between gap-4 p-4">
            <p
              aria-live="polite"
              aria-atomic="true"
              className="relative z-20 rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium tabular-nums text-white/90"
            >
              <span className="sr-only">Photo </span>
              {index + 1} of {photos.length}
            </p>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className={cn(
                CONTROL,
                "pointer-events-auto bg-black/50 text-white/90",
                "hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none",
              )}
            >
              <X className="size-5" />
            </button>
          </header>

          <div
            className="pointer-events-none relative z-10 min-h-0 flex-1"
            onPointerDown={(event) => {
              // Mouse drags are left alone: on a desktop a press-and-move is
              // more likely a selection attempt than a swipe, and the click
              // that follows should reach the backdrop.
              if (event.pointerType === "mouse") return;
              pointer.current = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
              };
            }}
            onPointerMove={(event) => {
              const start = pointer.current;
              if (!start || start.id !== event.pointerId) return;

              setDrag({
                x: event.clientX - start.x,
                y: event.clientY - start.y,
              });
            }}
            onPointerUp={(event) => {
              const start = pointer.current;
              if (!start || start.id !== event.pointerId) return;

              pointer.current = null;
              endDrag(event.clientX - start.x, event.clientY - start.y);
            }}
            onPointerCancel={() => {
              pointer.current = null;
              setDrag(null);
            }}
            style={{ touchAction: "none" }}
          >
            {/*
              Absolutely positioned, and it is the element that gets measured.
              Both matter.

              Measuring the stage instead let the photograph feed back into its
              own measurement: an oversized figure influenced the box it was
              being sized against, and the height settled on a value taken from
              a moment when the stage was taller than it ended up. A portrait
              photograph came out 1968px tall in a 780px stage, hanging past the
              bottom of the screen and over the credit.

              With the frame taken out of flow, its size comes only from these
              insets — which is to say from the viewport, the header and the
              footer — and nothing inside it can change that. The insets also
              replace the stage's old horizontal padding, so the measured box is
              the space actually available rather than that space plus padding.
            */}
            <div
              ref={setStage}
              // Fades and grows very slightly on open, so the photograph arrives
              // rather than appearing. On the stage rather than the figure
              // inside it, because that figure's transform is the swipe-to-
              // dismiss drag and the two would overwrite each other. There is
              // no closing animation: dismissing is something the reader asked
              // for, and it should already be done.
              className="absolute inset-y-0 left-2 right-2 flex items-center justify-center animate-in fade-in zoom-in-95 duration-200 ease-out sm:left-16 sm:right-16"
            >
              <figure
                className="pointer-events-auto relative"
                style={{
                  width: size?.width,
                  height: size?.height,
                  // A belt to the measurement's braces. If a size is ever missing
                  // again, the photograph is still confined to its frame
                  // instead of running off the screen.
                  maxWidth: "100%",
                  maxHeight: "100%",
                  transform:
                    drag === null
                      ? undefined
                      : `translate(${drag.x}px, ${Math.max(0, drag.y)}px)`,
                  opacity: 1 - dismissProgress,
                }}
              >
                {photo.blurhash !== null && (
                  <BlurhashCanvas hash={photo.blurhash} className="rounded-sm" />
                )}

                {/*
                  A plain img rather than next/image: the size is computed here
                  to the pixel, and the URL already asks Unsplash's CDN for
                  exactly that variant. Routing it through the Next optimiser
                  would re-encode an image that is already the right one.
                */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={photo.id}
                  src={source}
                  alt={
                    photo.photographerName === null
                      ? ""
                      : `Photograph by ${photo.photographerName}`
                  }
                  width={photo.width}
                  height={photo.height}
                  draggable={false}
                  onLoad={() => {
                    setLoaded(true);
                  }}
                  className={cn(
                    "relative h-full w-full rounded-sm object-contain transition-opacity duration-300",
                    loaded ? "opacity-100" : "opacity-0",
                  )}
                />
              </figure>
            </div>

            {index > 0 && (
              <button
                type="button"
                onClick={() => {
                  go(-1);
                }}
                aria-label="Previous photo"
                className={cn(
                  CONTROL,
                  "pointer-events-auto absolute top-1/2 left-2 -translate-y-1/2 bg-black/50 text-white/90",
                  "hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none",
                )}
              >
                <ChevronLeft className="size-6" />
              </button>
            )}

            {index < photos.length - 1 && (
              <button
                type="button"
                onClick={() => {
                  go(1);
                }}
                aria-label="Next photo"
                className={cn(
                  CONTROL,
                  "pointer-events-auto absolute top-1/2 right-2 -translate-y-1/2 bg-black/50 text-white/90",
                  "hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none",
                )}
              >
                <ChevronRight className="size-6" />
              </button>
            )}
          </div>

          <footer className="pointer-events-none relative z-20 p-4 text-center">
            {photo.photographerName !== null && (
              <p className="pointer-events-auto inline-block rounded-full bg-black/50 px-3 py-1.5 text-xs text-white/80">
                Photo by{" "}
                <a
                  href={photo.photographerUrl ?? UNSPLASH_HOME}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
                >
                  {photo.photographerName}
                </a>{" "}
                on{" "}
                <a
                  href={UNSPLASH_HOME}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
                >
                  Unsplash
                </a>
              </p>
            )}
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Makes the lightbox available to everything below it.
 *
 * One overlay for the whole screen rather than one per grid: the timeline
 * strips and the place panel both open the same thing, and only ever one at a
 * time. Radix's dialog supplies the parts that are easy to get subtly wrong —
 * the focus trap, the Escape handler, `aria-modal`, and locking the body
 * behind it — so what is left here is the photograph and the navigation.
 */
export function LightboxProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LightboxState | null>(null);

  const open = useCallback<OpenLightbox>((options) => {
    if (options.photos.length === 0) return;
    setState(options);
  }, []);

  const close = useCallback(() => {
    setState(null);
  }, []);

  const value = useMemo(() => open, [open]);

  return (
    <LightboxContext.Provider value={value}>
      {children}
      {state !== null && (
        // Keyed so that opening a different set starts fresh rather than
        // keeping the previous index and load state.
        <Lightbox
          key={`${state.label}-${state.photos[0]?.id ?? ""}-${state.index}`}
          state={state}
          onClose={close}
        />
      )}
    </LightboxContext.Provider>
  );
}
