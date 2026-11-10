import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

export type PreviewImage = {
  key: string;
  src: string;
  alt: string;
};

function ImageLightbox({
  images,
  index,
  onClose,
}: {
  images: PreviewImage[];
  index: number;
  onClose: () => void;
}) {
  const [active, setActive] = useState(index);
  const previous = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    previous.current = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key === "ArrowLeft" && images.length > 1)
        setActive((current) => (current + images.length - 1) % images.length);
      if (event.key === "ArrowRight" && images.length > 1)
        setActive((current) => (current + 1) % images.length);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous.current?.focus();
    };
  }, [images.length]);
  const image = images[active]!;
  return (
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        className="image-lightbox-close"
        aria-label="关闭图片预览"
        onClick={onClose}
      >
        <X size={20} />
      </button>
      {images.length > 1 && (
        <button
          type="button"
          className="image-lightbox-nav is-prev"
          aria-label="上一张图片"
          onClick={() =>
            setActive((current) => (current + images.length - 1) % images.length)
          }
        >
          <ChevronLeft size={22} />
        </button>
      )}
      <figure className="image-lightbox-stage">
        <img src={image.src} alt={image.alt} />
        {images.length > 1 && (
          <figcaption>
            {active + 1} / {images.length}
          </figcaption>
        )}
      </figure>
      {images.length > 1 && (
        <button
          type="button"
          className="image-lightbox-nav is-next"
          aria-label="下一张图片"
          onClick={() => setActive((current) => (current + 1) % images.length)}
        >
          <ChevronRight size={22} />
        </button>
      )}
    </div>
  );
}

export function ImageAttachmentPreview({
  images,
  className,
  label,
  indexOffset = 0,
  onImageLoad,
  onImageError,
}: {
  images: PreviewImage[];
  className?: string;
  label: string;
  indexOffset?: number;
  onImageLoad?: () => void;
  onImageError?: (image: PreviewImage) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (!images.length) return null;
  return (
    <>
      <div className={className} role="group" aria-label={label}>
        {images.map((image, index) => (
          <button
            type="button"
            className="image-thumb"
            key={image.key}
            aria-label={`预览第${index + indexOffset + 1}张图片`}
            onClick={() => setOpen(index)}
          >
            <img
              src={image.src}
              alt={image.alt}
              loading="lazy"
              onLoad={onImageLoad}
              onError={() => onImageError?.(image)}
            />
          </button>
        ))}
      </div>
      {open !== null && (
        <ImageLightbox
          images={images}
          index={open}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
