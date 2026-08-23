// The share director: the tree's unfurl card, drawn and uploaded when its owner shares a link, and
// the period's progress card, offered once per period and drawn again from the share sheet. Both
// take their pixels from the same model + layout the canvas paints, and both write the same ledger.
// The offer is armed during the load, fires on the tail of the ceremony that closes that open, and
// is dropped when a milestone lands in the same window.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { buildOgCardSvg } from './ogCard.js';
import { buildProgressCardSvg } from './progressCard.js';
import { considerProgressShare } from './progressOffer.js';
import { ProgressPeriod, newThisPeriod, ledgerDeltas, sinceLabel } from './progressPeriod.js';
import { svgToPngBlob } from './rasterize.js';
import { uploadOgImage, uploadOgVideo } from './ogUpload.js';
import { ShareLedger } from '../persistence/ShareLedger.js';
import { WeekOfferGate } from './weekOfferGate.js';

const shareLedger = new ShareLedger();

export function useWeekOffer({
  treeId, tree, states, shareStats, layoutPositions, viewPrefs,
  completed, completedAt, completedRef,
  treeMine, shared, demo, demotion, demotedRef,
  showToast, setShareOpen, ceremonyBusy,
}) {
  const plantedAtRef = useRef(0);            // epoch ms, 0 unrecorded — the period clock
  const cardCacheRef = useRef({ key: '', png: null }); // the last progress card rasterized
  const ceremonyBusyRef = useRef(ceremonyBusy); // the gate is built once and outlives every render
  const weekOfferGateRef = useRef(null);       // built on first use
  const openWeekSheetRef = useRef(null);     // the offer's toast outlives the render that built it
  const publishOgImageRef = useRef(null);    // the milestone beat has the same hazard

  ceremonyBusyRef.current = ceremonyBusy;
  if (!weekOfferGateRef.current) weekOfferGateRef.current = new WeekOfferGate(() => ceremonyBusyRef.current?.() ?? false);
  const armWeekOffer = useCallback((run) => weekOfferGateRef.current.arm(run), []);

  // A milestone in the same window wins the lane: the offer is dropped, never queued behind it,
  // and comes back next period because the ask was never committed.
  const dropWeekOffer = useCallback(() => weekOfferGateRef.current.drop(), []);

  // The offer follows the ceremony's closing beat rather than racing it.
  const followCeremony = useCallback(() => weekOfferGateRef.current.follow(), []);

  useEffect(() => () => weekOfferGateRef.current?.drop(), []);

  // The tree being left behind takes its period clock with it: never count a new tree's weeks from
  // an old one's planting.
  const forgetPeriod = useCallback(() => { plantedAtRef.current = 0; }, []);

  // The seed that lands sets it; another tree, another card, so the cache empties with it.
  const openPeriod = useCallback((plantedAt) => {
    plantedAtRef.current = plantedAt;
    cardCacheRef.current = { key: '', png: null };
  }, []);

  const clearShareLedger = useCallback((id) => shareLedger.clear(id), []);

  // Every share moves the baseline the next progress card is "since": the completed set as it
  // stands, the moment, and the share's ordinal. Written on a share, never on a completion.
  // `delta` is what the card being posted stamped; a link share carries no claim and passes null.
  const recordShare = useCallback((delta = null) => {
    const prior = shareLedger.load(treeId);
    shareLedger.save(treeId, { completed: completedRef.current, at: Date.now(), count: (prior?.count ?? 0) + 1, delta });
  }, [treeId, completedRef]);

  // Owner-only; every step is guarded so a failed card stays silent behind the generic image.
  const publishOgImage = useCallback(async () => {
    if (!treeMine || !tree || !shareStats) return;
    recordShare();
    try {
      const model = tree.toRenderModel(layoutPositions(tree), states);
      const card = {
        model,
        title: tree.title,
        done: shareStats.done,
        total: shareStats.total,
        dominantKind: shareStats.dominantKind,
      };
      const png = await svgToPngBlob(buildOgCardSvg(card));
      if (png) await uploadOgImage(treeId, png);
      // The motion companion goes after the poster, un-awaited, so the share link is ready at once.
      // The encoder and its mux library load on demand.
      import('./captureShareVideo.js')
        .then(({ captureShareVideo }) => captureShareVideo(card))
        .then((mp4) => { if (mp4) uploadOgVideo(treeId, mp4); })
        .catch(() => {});
    } catch { /* the unfurl artifacts are best-effort — never break sharing */ }
  }, [treeMine, tree, states, shareStats, layoutPositions, treeId, recordShare]);

  // The progress card's pixels; the tree's own og:image is untouched. One card is cached, keyed by
  // everything that can change it.
  const renderProgressCard = useCallback(async ({ lit, period, since, ledger }) => {
    if (!tree || !shareStats || !lit?.length) return null;
    const key = `${[...lit].sort().join(',')}|${period}|${since ?? ''}|${ledger ? ledger.join('·') : 'off'}`
      + `|${tree.title}|${shareStats.done}/${shareStats.total}`;
    if (cardCacheRef.current.key === key) return cardCacheRef.current.png;
    try {
      const model = tree.toRenderModel(layoutPositions(tree), states);
      // No dominant kind is passed: the card takes its hue from the steps that lit this period.
      const png = await svgToPngBlob(buildProgressCardSvg({
        model,
        title: tree.title,
        done: shareStats.done,
        total: shareStats.total,
        lit: new Set(lit),
        period,
        since,
        ledger,
      }));
      cardCacheRef.current = { key, png };
      return png;
    } catch {
      return null; // the sheet shows no preview; nothing breaks
    }
  }, [tree, states, shareStats, layoutPositions]);

  // What this period holds, and everything the sheet's second segment needs to post it. Derived,
  // never stored.
  const weekSegment = useMemo(() => {
    if (!treeMine || shared || demo || demotion || !tree) return null;
    const prior = shareLedger.load(treeId);
    const period = new ProgressPeriod({
      plantedAt: plantedAtRef.current,
      now: Date.now(),
      unit: viewPrefs.cardUnit(treeId),
      ordinal: (prior?.count ?? 0) + 1,
    });
    const { lit, sinceAt } = newThisPeriod({ completed, states, completedAt, prior, period });
    return {
      treeId,
      prefs: viewPrefs,
      week: { lit, sinceAt, plantedAt: period.plantedAt, ordinal: period.ordinal, ledger: ledgerDeltas({ history: prior?.history ?? [], period }) },
      renderCard: (options) => renderProgressCard({ lit, ...options }),
      onShared: () => recordShare(lit.length), // the card states its own stamp; the ledger cannot outrun it
    };
  }, [treeMine, shared, demo, demotion, tree, treeId, viewPrefs, completed, states, completedAt, renderProgressCard, recordShare]);

  // Taking the offer: draw the card, then open the sheet onto it. Accepting clears the declines.
  const openWeekSheet = useCallback(async (offer) => {
    offer.accept();
    const ledger = ledgerDeltas({ history: shareLedger.load(treeId)?.history ?? [], period: offer.period });
    await renderProgressCard({
      lit: offer.lit,
      period: offer.period.label,
      since: sinceLabel({ plantedAt: offer.period.plantedAt, at: offer.sinceAt, unit: offer.period.unit }),
      ledger: viewPrefs.cardLedger(treeId) ? ledger : null,
    });
    setShareOpen(true);
  }, [renderProgressCard, treeId, viewPrefs, setShareOpen]);

  // The toast is built at the open that earned it and tapped a beat later, after `states` and the
  // tree have moved on; going through the ref draws the tree as it stands when the sheet opens.
  openWeekSheetRef.current = openWeekSheet;
  publishOgImageRef.current = publishOgImage;

  // The week's offer: the first open after a period closes, armed here and fired by the ceremony.
  // Never mid-session, never twice in a period, and only for the owner of an editable tree.
  const considerWeekOffer = useCallback((seed, progress) => {
    if (!seed.mine || shared || demo || demotedRef.current) return;
    const weekOffer = considerProgressShare({
      treeId: seed.id,
      plantedAt: seed.createdAt ?? 0,
      completed: progress.completed,
      states: progress.states,
      completedAt: progress.completedAt,
      unit: viewPrefs.cardUnit(seed.id),
    });
    if (!weekOffer.offer) return;
    armWeekOffer(() => {
      // The ask is spent the moment it goes out and counts as declined until taken.
      weekOffer.commit({ countsAsDecline: true });
      const count = weekOffer.lit.length;
      showToast(`${weekOffer.period.label} · ${count} step${count === 1 ? '' : 's'} lit`, {
        duration: 6000,
        action: { label: 'Share the week', run: () => openWeekSheetRef.current?.(weekOffer) },
      });
    });
  }, [shared, demo, demotedRef, viewPrefs, showToast, armWeekOffer]);

  return {
    publishOgImage,
    publishOgImageRef,
    weekSegment,
    forgetPeriod,
    openPeriod,
    considerWeekOffer,
    followCeremony,
    dropWeekOffer,
    clearShareLedger,
  };
}
