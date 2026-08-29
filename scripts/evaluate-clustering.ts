/**
 * Scoring harness for the clustering pipeline.
 *
 *   npx tsx scripts/evaluate-clustering.ts
 *   npx tsx scripts/evaluate-clustering.ts --epsilon 60 --min-points 4
 *   npx tsx scripts/evaluate-clustering.ts --sweep
 *
 * Runs the pipeline over `data/rome-trip.json` and scores the result against
 * the generator's ground truth. No UI, no database — just the numbers that say
 * whether the clustering is any good before anything is built on top of it.
 *
 * Two accuracy numbers are reported, because one is not enough:
 *
 *  - **Photo accuracy** maps each predicted cluster to whichever true place
 *    contributed most of its photos, then asks how many photos landed in a
 *    cluster mapped to their real place. It is the intuitive number, and it
 *    forgives splitting: if one place breaks into two clean clusters, both map
 *    back to it and every photo still counts as correct.
 *  - **Pairwise F1** asks, for every pair of photos, whether the pipeline
 *    agrees with the truth about them belonging together. Splitting a place
 *    costs recall; merging two places costs precision. Nothing is forgiven.
 *
 * Read them together. High photo accuracy with mediocre F1 means the places are
 * right but the boundaries are not.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { haversineDistance } from "../src/lib/geo";
import { runPipeline } from "../src/lib/clustering/pipeline";
import type { PipelinePhoto, PipelineResult } from "../src/lib/clustering/pipeline";
import type {
  GeneratedTripDataset,
  PhotoAssignment,
  PhotoOrigin,
} from "../src/types";

const DEFAULT_DATA = "data/rome-trip.json";
const DEFAULT_EPSILON = 60;
const DEFAULT_MIN_POINTS = 4;

/** A cluster counts as holding a place if it has this share of its photos. */
const SPLIT_MIN_SHARE = 0.1;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface PlaceReport {
  placeId: string;
  name: string;
  truePhotoCount: number;
  /** The predicted cluster holding most of this place's photos. */
  dominantClusterId: string | null;
  /** Share of this place's photos that landed in the dominant cluster. */
  recall: number;
  /** Share of the dominant cluster's photos that really belong to this place. */
  precision: number;
  /** Clusters holding a meaningful share of this place's photos. */
  clusterIds: string[];
  split: boolean;
  mergedWith: string[];
  /** Distance from the dominant cluster's centroid to the real coordinates. */
  centroidErrorMeters: number | null;
}

interface Evaluation {
  epsilonMeters: number;
  minPoints: number;

  truePlaceCount: number;
  detectedPlaceCount: number;
  splitPlaceCount: number;
  mergedPlaceCount: number;
  lostPlaceCount: number;

  trueVisitCount: number;
  detectedVisitCount: number;
  /** True visits with a predicted visit covering at least half their photos. */
  matchedVisitCount: number;

  photoCount: number;
  photoAccuracy: number;
  placePhotoAccuracy: number;

  pairwisePrecision: number;
  pairwiseRecall: number;
  pairwiseF1: number;

  outlierCount: number;
  outliersLeftUnassigned: number;
  outlierDetail: { photoId: string; assignedTo: string | null }[];

  transitCount: number;
  transitLeftUnassigned: number;

  gpsLessCount: number;
  gpsLessRecoveredCorrect: number;
  gpsLessRecoveredWrong: number;
  gpsLessLeftUnpositioned: number;
  /** Median distance from an interpolated position to its true place centre. */
  gpsLessMedianErrorMeters: number | null;

  places: PlaceReport[];
  result: PipelineResult;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
}

function evaluate(
  dataset: GeneratedTripDataset,
  epsilonMeters: number,
  minPoints: number,
  visitGapMinutes: number,
  maxInterpolationGapMinutes: number,
): Evaluation {
  const photos: PipelinePhoto[] = dataset.photos.map((photo) => ({
    id: photo.id,
    takenAt: photo.takenAt === null ? null : new Date(photo.takenAt),
    lat: photo.lat,
    lng: photo.lng,
  }));

  const result = runPipeline(photos, {
    epsilonMeters,
    minPoints,
    visitGapMinutes,
    maxInterpolationGapMinutes,
  });

  // --- index the truth and the prediction ---------------------------------

  const assignmentByPhoto = new Map<string, PhotoAssignment>(
    dataset.groundTruth.assignments.map((a) => [a.photoId, a]),
  );
  const placeById = new Map(
    dataset.groundTruth.places.map((place) => [place.id, place]),
  );
  const predictionByPhoto = new Map(
    result.placements.map((placement) => [placement.photoId, placement]),
  );
  const predictedPlaceById = new Map(
    result.places.map((place) => [place.id, place]),
  );

  const truePlaceOf = (photoId: string): string | null =>
    assignmentByPhoto.get(photoId)?.placeId ?? null;
  const predictedPlaceOf = (photoId: string): string | null =>
    predictionByPhoto.get(photoId)?.placeId ?? null;
  const originOf = (photoId: string): PhotoOrigin =>
    assignmentByPhoto.get(photoId)?.origin ?? "transit";

  // --- contingency table: true place x predicted cluster ------------------

  const byTruePlace = new Map<string, Map<string, number>>();
  const byCluster = new Map<string, Map<string, number>>();

  for (const photo of dataset.photos) {
    const truePlaceId = truePlaceOf(photo.id);
    const clusterId = predictedPlaceOf(photo.id);
    if (truePlaceId === null || clusterId === null) continue;

    const forPlace = byTruePlace.get(truePlaceId) ?? new Map<string, number>();
    forPlace.set(clusterId, (forPlace.get(clusterId) ?? 0) + 1);
    byTruePlace.set(truePlaceId, forPlace);

    const forCluster = byCluster.get(clusterId) ?? new Map<string, number>();
    forCluster.set(truePlaceId, (forCluster.get(truePlaceId) ?? 0) + 1);
    byCluster.set(clusterId, forCluster);
  }

  /** Each cluster stands for the true place that contributed most of it. */
  const clusterMeans = new Map<string, string>();
  for (const [clusterId, contributors] of byCluster) {
    let best: string | null = null;
    let bestCount = -1;
    for (const [truePlaceId, count] of contributors) {
      if (count > bestCount) {
        bestCount = count;
        best = truePlaceId;
      }
    }
    if (best !== null) clusterMeans.set(clusterId, best);
  }

  // --- per-place reports --------------------------------------------------

  const dominantClusterOf = new Map<string, string>();
  const places: PlaceReport[] = dataset.groundTruth.places.map((place) => {
    const truePhotoCount = dataset.groundTruth.assignments.filter(
      (a) => a.placeId === place.id,
    ).length;

    const spread = byTruePlace.get(place.id) ?? new Map<string, number>();

    let dominantClusterId: string | null = null;
    let dominantCount = 0;
    for (const [clusterId, count] of spread) {
      if (count > dominantCount) {
        dominantCount = count;
        dominantClusterId = clusterId;
      }
    }
    if (dominantClusterId !== null) {
      dominantClusterOf.set(place.id, dominantClusterId);
    }

    const threshold = Math.max(2, truePhotoCount * SPLIT_MIN_SHARE);
    const clusterIds = [...spread.entries()]
      .filter(([, count]) => count >= threshold)
      .sort((a, b) => b[1] - a[1])
      .map(([clusterId]) => clusterId);

    const clusterTotal =
      dominantClusterId === null
        ? 0
        : [...(byCluster.get(dominantClusterId) ?? new Map()).values()].reduce(
            (sum: number, n: number) => sum + n,
            0,
          );

    const predicted =
      dominantClusterId === null
        ? undefined
        : predictedPlaceById.get(dominantClusterId);

    return {
      placeId: place.id,
      name: place.name,
      truePhotoCount,
      dominantClusterId,
      recall: truePhotoCount === 0 ? 0 : dominantCount / truePhotoCount,
      precision: clusterTotal === 0 ? 0 : dominantCount / clusterTotal,
      clusterIds,
      split: clusterIds.length >= 2,
      mergedWith: [],
      centroidErrorMeters: predicted
        ? haversineDistance(predicted, place)
        : null,
    };
  });

  // Two true places sharing a dominant cluster were merged into one.
  const placesByDominant = new Map<string, PlaceReport[]>();
  for (const report of places) {
    if (report.dominantClusterId === null) continue;
    const group = placesByDominant.get(report.dominantClusterId) ?? [];
    group.push(report);
    placesByDominant.set(report.dominantClusterId, group);
  }
  for (const group of placesByDominant.values()) {
    if (group.length < 2) continue;
    for (const report of group) {
      report.mergedWith = group
        .filter((other) => other.placeId !== report.placeId)
        .map((other) => other.name);
    }
  }

  // --- per-photo accuracy -------------------------------------------------

  let correct = 0;
  let placePhotos = 0;
  let placePhotosCorrect = 0;

  for (const photo of dataset.photos) {
    const origin = originOf(photo.id);
    const clusterId = predictedPlaceOf(photo.id);

    if (origin === "place") {
      placePhotos += 1;
      const isCorrect =
        clusterId !== null && clusterMeans.get(clusterId) === truePlaceOf(photo.id);
      if (isCorrect) {
        placePhotosCorrect += 1;
        correct += 1;
      }
    } else if (clusterId === null) {
      // Transit and outlier photos are right only when left out of every place.
      correct += 1;
    }
  }

  // --- pairwise precision / recall / F1 over place photos -----------------

  const placePhotoIds = dataset.photos
    .map((photo) => photo.id)
    .filter((id) => originOf(id) === "place");

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (let i = 0; i < placePhotoIds.length; i += 1) {
    const idA = placePhotoIds[i] as string;
    const trueA = truePlaceOf(idA);
    const predA = predictedPlaceOf(idA);

    for (let j = i + 1; j < placePhotoIds.length; j += 1) {
      const idB = placePhotoIds[j] as string;
      const sameTruth = trueA === truePlaceOf(idB);
      const samePrediction = predA !== null && predA === predictedPlaceOf(idB);

      if (sameTruth && samePrediction) truePositives += 1;
      else if (!sameTruth && samePrediction) falsePositives += 1;
      else if (sameTruth && !samePrediction) falseNegatives += 1;
    }
  }

  const pairwisePrecision =
    truePositives + falsePositives === 0
      ? 0
      : truePositives / (truePositives + falsePositives);
  const pairwiseRecall =
    truePositives + falseNegatives === 0
      ? 0
      : truePositives / (truePositives + falseNegatives);
  const pairwiseF1 =
    pairwisePrecision + pairwiseRecall === 0
      ? 0
      : (2 * pairwisePrecision * pairwiseRecall) /
        (pairwisePrecision + pairwiseRecall);

  // --- visits -------------------------------------------------------------

  const predictedVisitOf = new Map<string, string>();
  for (const placement of result.placements) {
    if (placement.visitId !== null) {
      predictedVisitOf.set(placement.photoId, placement.visitId);
    }
  }

  const truePhotosByVisit = new Map<string, string[]>();
  for (const assignment of dataset.groundTruth.assignments) {
    if (assignment.visitId === null) continue;
    const list = truePhotosByVisit.get(assignment.visitId) ?? [];
    list.push(assignment.photoId);
    truePhotosByVisit.set(assignment.visitId, list);
  }

  // A true visit counts as recovered when some predicted visit holds at least
  // half its photos — and each predicted visit can only stand for one true
  // visit. Without that exclusivity, two stays merged into a single predicted
  // visit would both score as recovered, which is exactly the failure the
  // temporal split exists to prevent.
  const overlaps: { trueVisitId: string; visitId: string; share: number }[] = [];

  for (const [trueVisitId, photoIds] of truePhotosByVisit) {
    const counts = new Map<string, number>();
    for (const photoId of photoIds) {
      const visitId = predictedVisitOf.get(photoId);
      if (visitId === undefined) continue;
      counts.set(visitId, (counts.get(visitId) ?? 0) + 1);
    }
    for (const [visitId, count] of counts) {
      overlaps.push({ trueVisitId, visitId, share: count / photoIds.length });
    }
  }

  overlaps.sort((a, b) => b.share - a.share);

  const claimedTrueVisits = new Set<string>();
  const claimedVisits = new Set<string>();
  let matchedVisitCount = 0;

  for (const overlap of overlaps) {
    if (overlap.share < 0.5) break;
    if (claimedTrueVisits.has(overlap.trueVisitId)) continue;
    if (claimedVisits.has(overlap.visitId)) continue;

    claimedTrueVisits.add(overlap.trueVisitId);
    claimedVisits.add(overlap.visitId);
    matchedVisitCount += 1;
  }

  // --- outliers and transit ----------------------------------------------

  const outlierIds = dataset.groundTruth.assignments
    .filter((a) => a.origin === "outlier")
    .map((a) => a.photoId);
  const transitIds = dataset.groundTruth.assignments
    .filter((a) => a.origin === "transit")
    .map((a) => a.photoId);

  const outlierDetail = outlierIds.map((photoId) => ({
    photoId,
    assignedTo: predictedPlaceOf(photoId),
  }));

  // --- GPS-less recovery --------------------------------------------------

  const gpsLessIds = dataset.photos
    .filter((photo) => photo.lat === null)
    .map((photo) => photo.id);

  let gpsLessRecoveredCorrect = 0;
  let gpsLessRecoveredWrong = 0;
  let gpsLessLeftUnpositioned = 0;
  const gpsLessErrors: number[] = [];

  for (const photoId of gpsLessIds) {
    const placement = predictionByPhoto.get(photoId);
    const truePlaceId = truePlaceOf(photoId);

    if (!placement || placement.lat === null || placement.lng === null) {
      gpsLessLeftUnpositioned += 1;
      continue;
    }

    const truePlace = truePlaceId === null ? null : placeById.get(truePlaceId);
    if (truePlace) {
      gpsLessErrors.push(
        haversineDistance(
          { lat: placement.lat, lng: placement.lng },
          truePlace,
        ),
      );
    }

    const clusterId = placement.placeId;
    if (clusterId !== null && clusterMeans.get(clusterId) === truePlaceId) {
      gpsLessRecoveredCorrect += 1;
    } else {
      gpsLessRecoveredWrong += 1;
    }
  }

  return {
    epsilonMeters,
    minPoints,

    truePlaceCount: dataset.groundTruth.places.length,
    detectedPlaceCount: result.places.length,
    splitPlaceCount: places.filter((p) => p.split).length,
    mergedPlaceCount: places.filter((p) => p.mergedWith.length > 0).length,
    lostPlaceCount: places.filter((p) => p.dominantClusterId === null).length,

    trueVisitCount: dataset.groundTruth.visits.length,
    detectedVisitCount: result.visits.length,
    matchedVisitCount,

    photoCount: dataset.photos.length,
    photoAccuracy: correct / dataset.photos.length,
    placePhotoAccuracy: placePhotos === 0 ? 0 : placePhotosCorrect / placePhotos,

    pairwisePrecision,
    pairwiseRecall,
    pairwiseF1,

    outlierCount: outlierIds.length,
    outliersLeftUnassigned: outlierDetail.filter((o) => o.assignedTo === null)
      .length,
    outlierDetail,

    transitCount: transitIds.length,
    transitLeftUnassigned: transitIds.filter(
      (id) => predictedPlaceOf(id) === null,
    ).length,

    gpsLessCount: gpsLessIds.length,
    gpsLessRecoveredCorrect,
    gpsLessRecoveredWrong,
    gpsLessLeftUnpositioned,
    gpsLessMedianErrorMeters: median(gpsLessErrors),

    places,
    result,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type Alignment = "left" | "right";

function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  align: readonly Alignment[],
): string {
  const widths = headers.map((header, column) =>
    Math.max(
      header.length,
      ...rows.map((row) => (row[column] ?? "").length),
    ),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => {
        const width = widths[column] as number;
        return align[column] === "right"
          ? cell.padStart(width)
          : cell.padEnd(width);
      })
      .join("  ")
      .trimEnd();

  return [
    line(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(line),
  ].join("\n");
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

function printReport(evaluation: Evaluation): void {
  const out = (text = ""): void => {
    process.stdout.write(`${text}\n`);
  };

  out();
  out(`Clustering evaluation  (epsilon ${evaluation.epsilonMeters}m, minPoints ${evaluation.minPoints})`);
  out("=".repeat(72));
  out();

  out("Places");
  out(`  detected               ${evaluation.detectedPlaceCount} (true: ${evaluation.truePlaceCount})`);
  out(`  split across clusters  ${evaluation.splitPlaceCount}`);
  out(`  merged with another    ${evaluation.mergedPlaceCount}`);
  out(`  lost entirely          ${evaluation.lostPlaceCount}`);
  out();

  out("Visits");
  out(`  detected               ${evaluation.detectedVisitCount} (true: ${evaluation.trueVisitCount})`);
  out(`  recovered (>=50% of a true visit's photos)  ${evaluation.matchedVisitCount}/${evaluation.trueVisitCount}`);
  out();

  out("Photos");
  out(`  overall accuracy       ${percent(evaluation.photoAccuracy)}  (${evaluation.photoCount} photos)`);
  out(`  place photos only      ${percent(evaluation.placePhotoAccuracy)}`);
  out(`  pairwise precision     ${percent(evaluation.pairwisePrecision)}  (merging costs this)`);
  out(`  pairwise recall        ${percent(evaluation.pairwiseRecall)}  (splitting costs this)`);
  out(`  pairwise F1            ${percent(evaluation.pairwiseF1)}`);
  out();

  out("Photos that belong nowhere");
  out(`  outliers left out      ${evaluation.outliersLeftUnassigned}/${evaluation.outlierCount}`);
  for (const outlier of evaluation.outlierDetail) {
    const verdict =
      outlier.assignedTo === null
        ? "left unassigned (correct)"
        : `absorbed into ${outlier.assignedTo} (wrong)`;
    out(`    ${outlier.photoId}  ${verdict}`);
  }
  out(`  transit left out       ${evaluation.transitLeftUnassigned}/${evaluation.transitCount}`);
  out();

  out("Photos that arrived without GPS");
  out(`  total                  ${evaluation.gpsLessCount}`);
  out(`  recovered, correct     ${evaluation.gpsLessRecoveredCorrect}`);
  out(`  recovered, wrong place ${evaluation.gpsLessRecoveredWrong}`);
  out(`  left unpositioned      ${evaluation.gpsLessLeftUnpositioned}`);
  out(
    `  median position error  ${
      evaluation.gpsLessMedianErrorMeters === null
        ? "n/a"
        : `${evaluation.gpsLessMedianErrorMeters.toFixed(0)}m from the true place centre`
    }`,
  );
  out();

  out("Per place");
  const rows = evaluation.places
    .slice()
    .sort((a, b) => b.truePhotoCount - a.truePhotoCount)
    .map((place) => {
      const status: string[] = [];
      if (place.dominantClusterId === null) status.push("LOST");
      if (place.split) status.push(`SPLIT x${place.clusterIds.length}`);
      if (place.mergedWith.length > 0) {
        status.push(`MERGED with ${place.mergedWith.join(" + ")}`);
      }

      return [
        place.name,
        String(place.truePhotoCount),
        place.dominantClusterId ?? "-",
        percent(place.recall),
        percent(place.precision),
        place.centroidErrorMeters === null
          ? "-"
          : `${place.centroidErrorMeters.toFixed(0)}m`,
        status.length === 0 ? "ok" : status.join(", "),
      ];
    });

  out(
    renderTable(
      ["place", "photos", "cluster", "recall", "prec.", "centroid err", "status"],
      rows,
      ["left", "right", "left", "right", "right", "right", "left"],
    )
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );
  out();
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

const SWEEP_EPSILON_START = 20;
const SWEEP_EPSILON_END = 200;
const SWEEP_EPSILON_STEP = 10;
const SWEEP_MIN_POINTS: readonly number[] = [3, 4, 5];

function runSweep(
  dataset: GeneratedTripDataset,
  visitGapMinutes: number,
  maxInterpolationGapMinutes: number,
): void {
  const out = (text = ""): void => {
    process.stdout.write(`${text}\n`);
  };

  const results: Evaluation[] = [];

  for (const minPoints of SWEEP_MIN_POINTS) {
    for (
      let epsilon = SWEEP_EPSILON_START;
      epsilon <= SWEEP_EPSILON_END;
      epsilon += SWEEP_EPSILON_STEP
    ) {
      results.push(
        evaluate(
          dataset,
          epsilon,
          minPoints,
          visitGapMinutes,
          maxInterpolationGapMinutes,
        ),
      );
    }
  }

  // Best by overall photo accuracy; ties broken by pairwise F1, then by
  // landing closest to the true number of places.
  const rank = (a: Evaluation, b: Evaluation): number => {
    if (b.photoAccuracy !== a.photoAccuracy) return b.photoAccuracy - a.photoAccuracy;
    if (b.pairwiseF1 !== a.pairwiseF1) return b.pairwiseF1 - a.pairwiseF1;
    return (
      Math.abs(a.detectedPlaceCount - a.truePlaceCount) -
      Math.abs(b.detectedPlaceCount - b.truePlaceCount)
    );
  };

  const best = [...results].sort(rank)[0] as Evaluation;
  const bestByF1 = [...results].sort((a, b) => b.pairwiseF1 - a.pairwiseF1)[0] as Evaluation;

  // Photo accuracy and structural correctness are not the same goal. A wider
  // epsilon sweeps up more loose photos, which raises accuracy, while quietly
  // fusing two nearby places into one — and on a map, "twelve pins, the right
  // twelve" can matter more than a handful of extra photos in the right pile.
  // So the sweep also reports whichever setting reproduces the true shape of
  // the trip most faithfully.
  const structuralError = (r: Evaluation): number =>
    Math.abs(r.detectedPlaceCount - r.truePlaceCount) +
    Math.abs(r.detectedVisitCount - r.trueVisitCount) +
    r.splitPlaceCount +
    r.mergedPlaceCount +
    r.lostPlaceCount;

  const bestStructure = [...results].sort((a, b) => {
    const delta = structuralError(a) - structuralError(b);
    return delta !== 0 ? delta : b.photoAccuracy - a.photoAccuracy;
  })[0] as Evaluation;

  out();
  out(
    `Parameter sweep  (epsilon ${SWEEP_EPSILON_START}-${SWEEP_EPSILON_END}m step ${SWEEP_EPSILON_STEP}, minPoints ${SWEEP_MIN_POINTS.join("/")})`,
  );
  out("=".repeat(96));

  for (const minPoints of SWEEP_MIN_POINTS) {
    const forMinPoints = results.filter((r) => r.minPoints === minPoints);

    out();
    out(`minPoints = ${minPoints}`);

    const rows = forMinPoints.map((r) => [
      r === best ? "*" : r === bestStructure ? "+" : " ",
      `${r.epsilonMeters}m`,
      String(r.detectedPlaceCount),
      String(r.detectedVisitCount),
      String(r.splitPlaceCount),
      String(r.mergedPlaceCount),
      String(r.lostPlaceCount),
      percent(r.photoAccuracy),
      percent(r.pairwiseF1),
      `${r.outliersLeftUnassigned}/${r.outlierCount}`,
      `${r.transitLeftUnassigned}/${r.transitCount}`,
      `${r.gpsLessRecoveredCorrect}/${r.gpsLessCount}`,
    ]);

    out(
      renderTable(
        [
          " ",
          "eps",
          "places",
          "visits",
          "split",
          "merged",
          "lost",
          "photo acc",
          "pair F1",
          "outliers",
          "transit",
          "gps rec.",
        ],
        rows,
        [
          "left",
          "right",
          "right",
          "right",
          "right",
          "right",
          "right",
          "right",
          "right",
          "right",
          "right",
          "right",
        ],
      )
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );
  }

  out();
  out("-".repeat(96));
  out(
    `* best: epsilon ${best.epsilonMeters}m, minPoints ${best.minPoints}` +
      ` -- ${percent(best.photoAccuracy)} photo accuracy,` +
      ` ${percent(best.pairwiseF1)} pairwise F1,` +
      ` ${best.detectedPlaceCount} places (true ${best.truePlaceCount}),` +
      ` ${best.detectedVisitCount} visits (true ${best.trueVisitCount})`,
  );

  if (bestByF1 !== best) {
    out(
      `  best by pairwise F1 instead: epsilon ${bestByF1.epsilonMeters}m,` +
        ` minPoints ${bestByF1.minPoints} -- ${percent(bestByF1.pairwiseF1)} F1,` +
        ` ${percent(bestByF1.photoAccuracy)} photo accuracy`,
    );
  }

  out(
    `+ truest structure: epsilon ${bestStructure.epsilonMeters}m,` +
      ` minPoints ${bestStructure.minPoints}` +
      ` -- ${bestStructure.detectedPlaceCount} places (true ${bestStructure.truePlaceCount}),` +
      ` ${bestStructure.detectedVisitCount} visits (true ${bestStructure.trueVisitCount}),` +
      ` ${bestStructure.splitPlaceCount} split, ${bestStructure.mergedPlaceCount} merged,` +
      ` ${bestStructure.lostPlaceCount} lost` +
      ` -- at ${percent(bestStructure.photoAccuracy)} photo accuracy`,
  );
  out();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `
Usage: tsx scripts/evaluate-clustering.ts [options]

  --data <path>         Dataset to score against   (default: ${DEFAULT_DATA})
  --epsilon <metres>    DBSCAN radius              (default: ${DEFAULT_EPSILON})
  --min-points <int>    DBSCAN core threshold      (default: ${DEFAULT_MIN_POINTS})
  --visit-gap <min>     Gap that splits two visits (default: 90)
  --interp-gap <min>    Widest interpolation gap   (default: 120)
  --sweep               Sweep epsilon ${SWEEP_EPSILON_START}-${SWEEP_EPSILON_END}m at minPoints ${SWEEP_MIN_POINTS.join("/")}
  --help                Show this message
`.trimStart();

function parseNumber(
  raw: string | undefined,
  fallback: number,
  label: string,
  isValid: (value: number) => boolean,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !isValid(value)) {
    throw new Error(`Invalid --${label}: "${raw}"`);
  }
  return value;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      data: { type: "string" },
      epsilon: { type: "string" },
      "min-points": { type: "string" },
      "visit-gap": { type: "string" },
      "interp-gap": { type: "string" },
      sweep: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const dataPath = resolve(process.cwd(), values.data ?? DEFAULT_DATA);
  const dataset = JSON.parse(
    readFileSync(dataPath, "utf8"),
  ) as GeneratedTripDataset;

  const visitGapMinutes = parseNumber(
    values["visit-gap"],
    90,
    "visit-gap",
    (value) => value > 0,
  );
  const maxInterpolationGapMinutes = parseNumber(
    values["interp-gap"],
    120,
    "interp-gap",
    (value) => value > 0,
  );

  process.stdout.write(
    `Dataset: ${dataPath}\n` +
      `  ${dataset.photos.length} photos, ` +
      `${dataset.groundTruth.places.length} true places, ` +
      `${dataset.groundTruth.visits.length} true visits, ` +
      `seed ${dataset.meta.seed}\n`,
  );

  if (values.sweep) {
    runSweep(dataset, visitGapMinutes, maxInterpolationGapMinutes);
    return;
  }

  const epsilonMeters = parseNumber(
    values.epsilon,
    DEFAULT_EPSILON,
    "epsilon",
    (value) => value > 0,
  );
  const minPoints = parseNumber(
    values["min-points"],
    DEFAULT_MIN_POINTS,
    "min-points",
    Number.isInteger,
  );

  printReport(
    evaluate(
      dataset,
      epsilonMeters,
      minPoints,
      visitGapMinutes,
      maxInterpolationGapMinutes,
    ),
  );
}

const entry = process.argv[1];
const invokedDirectly =
  entry !== undefined &&
  resolve(entry).replace(/\\/g, "/").endsWith("/scripts/evaluate-clustering.ts");

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

export { evaluate };
export type { Evaluation, PlaceReport };
