import { num, norm, POT_MEDIA_ML } from "./util.ts";
import type { IntakeIrr, SopBundle } from "./types.ts";

export function resolveMedia(intake: IntakeIrr, bundle: SopBundle, fcFromWhc: number) {
  const media = norm(intake.medium || "coco");
  const container = String(intake.container || "1").replace(/[^\d.]/g, "") || "1";
  const mediaKey = `${media}|${container}`;
  const fill = bundle.media_fill_factor ?? 1.0;

  const fromBundle = bundle.media?.[mediaKey];
  let mediaMl = fromBundle?.v_media_ml ?? null;
  if (mediaMl == null) {
    const gal = num(container, 1) ?? 1;
    const base = POT_MEDIA_ML[String(Math.round(gal))] ?? gal * 3785.41;
    mediaMl = base * fill;
  }

  const potGal = num(container, 1) ?? undefined;
  const fc_vwc = fcFromWhc;
  const vwc_floor = fromBundle?.vwc_floor ?? 10;

  return { mediaMl, potGal, fc_vwc, vwc_floor, mediaKey };
}
