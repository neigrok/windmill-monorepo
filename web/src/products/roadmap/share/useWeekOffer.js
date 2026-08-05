// The share director (briefs #12 and #20): the two things this product publishes, and the conduct
// of the one that asks. The tree's unfurl card is drawn and uploaded when its owner shares a link;
// the period's progress card is offered once per period, on the open that earned it, and drawn
// again from the share sheet. Both take their pixels from the same model + layout the canvas
// paints, and both write the same ledger — which is why they are one hook and not two.
//
// The offer's conduct is the part worth naming. It is armed during the load, fires on the tail of
// whatever ceremony closes that open (the welcome-back recap, or the arrival standing in for it),
// and is dropped outright when a milestone lands in the same window — one pride moment per open,
// the ask never queued behind it. The cap is a safety net, not a schedule: under the phone list
// the scene is paused and no ceremony ever speaks, and an offer that can never fire is a feature
// quietly lost.
//
// What is NOT here: the Share dialog's own open flag, and the tree's share stats. Both have other
// tenants (the control bar, the action lane, the milestone beat, every mobile plaque), so they
// stay where every surface can reach them and arrive here as arguments.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { buildOgCardSvg } from './ogCard.js';
import { buildProgressCardSvg } from './progressCard.js';
import { considerProgressShare } from './progressOffer.js';
import { ProgressPeriod, newThisPeriod, ledgerDeltas, sinceLabel } from './progressPeriod.js';
import { svgToPngBlob } from './rasterize.js';
import { uploadOgImage, uploadOgVideo } from './ogUpload.js';
import { ShareLedger } from '../persistence/ShareLedger.js';

const shareLedger = new ShareLedger();
const WEEK_OFFER_GAP_MS = 120;      // the week's offer follows the recap's last beat, never races it (#20 C7)
const CEREMONY_TAIL_CAP_MS = 2600;  // past the director's 2400ms structural budget: no ceremony spoke, fire anyway

export function useWeekOffer({
  treeId, tree, states, shareStats, layoutPositions, viewPrefs,
  completed, completedAt, completedRef,
  treeMine, shared, demo, demotion, demotedRef,
  showToast, setShareOpen,
}) {
  const plantedAtRef = useRef(0);            // when this tree was planted (epoch ms, 0 unrecorded) — the period clock
  const cardCacheRef = useRef({ key: '', png: null }); // the last progress card rasterized, so the sheet opens onto a drawn one
  const weekOfferRef = useRef(null);         // the armed week offer awaiting the open's last beat: { run, timer } | null
  const openWeekSheetRef = useRef(null);     // latest openWeekSheet — the offer's toast outlives its render
  const publishOgImageRef = useRef(null);    // same hazard on the milestone beat, which predates it

  const fireWeekOffer = useCallback((delay) => {
    const armed = weekOfferRef.current;
    if (!armed?.run) return;
    clearTimeout(armed.timer);
    weekOfferRef.current = { run: null, timer: setTimeout(armed.run, delay) };
  }, []);

  const armWeekOffer = useCallback((run) => {
    clearTimeout(weekOfferRef.current?.timer);
    weekOfferRef.current = { run, timer: setTimeout(() => fireWeekOffer(0), CEREMONY_TAIL_CAP_MS) };
  }, [fireWeekOffer]);

  // A milestone in the same window WINS the lane, and the week's offer is dropped rather than
  // queued behind it: one pride moment per open. It costs nothing — the ask was never committed,
  // so it comes back next period.
  const dropWeekOffer = useCallback(() => {
    clearTimeout(weekOfferRef.current?.timer);
    weekOfferRef.current = null;
  }, []);

  // Every ceremony's closing beat comes through the scene's one toast sink, which is what makes it
  // the seam the week's offer waits on: it FOLLOWS that beat by 120ms instead of racing it, so the
  // ask lands on a tree that has finished moving.
  const followCeremony = useCallback(() => fireWeekOffer(WEEK_OFFER_GAP_MS), [fireWeekOffer]);

  useEffect(() => () => clearTimeout(weekOfferRef.current?.timer), []);

  // The tree being left behind takes its period clock with it: never count a new tree's weeks
  // from an old one's planting.
  const forgetPeriod = useCallback(() => { plantedAtRef.current = 0; }, []);

  // …and the seed that lands sets it. Another tree, another card, so the cache empties with it.
  const openPeriod = useCallback((plantedAt) => {
    plantedAtRef.current = plantedAt;
    cardCacheRef.current = { key: '', png: null };
  }, []);

  const clearShareLedger = useCallback((id) => shareLedger.clear(id), []);

  // Every share moves the baseline the NEXT progress card is "since" (brief #20): the completed
  // set as it stands right now, the moment, and the share's ordinal. Written here and only here —
  // never on a completion — because a baseline that survives your own work is the only honest way
  // to say "since you last shared" without per-node timestamps from the server. `delta` is what the
  // card being posted stamped, so every later card's ledger row agrees with the picture this one
  // published; a link share carries no such claim and lets the ledger take the set difference.
  const recordShare = useCallback((delta = null) => {
    const prior = shareLedger.load(treeId);
    shareLedger.save(treeId, { completed: completedRef.current, at: Date.now(), count: (prior?.count ?? 0) + 1, delta });
  }, [treeId, completedRef]);

  // When the owner shares, publish the tree's unfurl card (brief #12): build the SVG from the
  // same model + layout the canvas draws, rasterize it, and upload it — all best-effort, off
  // the copy interaction. Owner-only (treeMine), and every step is guarded so a failed card
  // (bad raster, offline, no DOM) stays silent and the backend's generic image covers it.
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
      // The motion companion (#19): kicked off AFTER the poster is up, un-awaited, so the share
      // link is ready instantly and the ~3s encode + upload lands a beat later. Best-effort — a
      // failed or unsupported encode just leaves the poster, never blocks or breaks sharing. The
      // encoder (and its heavy WebCodecs/mux library) is loaded on demand here so it never weighs
      // down the initial page — only an owner who actually shares ever pays for it.
      import('./captureShareVideo.js')
        .then(({ captureShareVideo }) => captureShareVideo(card))
        .then((mp4) => { if (mp4) uploadOgVideo(treeId, mp4); })
        .catch(() => {});
    } catch { /* the unfurl artifacts are best-effort — never break sharing */ }
  }, [treeMine, tree, states, shareStats, layoutPositions, treeId, recordShare]);

  // The progress card's pixels (brief #20). The share sheet owns the settings; this owns the
  // drawing — the same model + layout the canvas paints, rasterized by the same rasterizer the
  // unfurl card uses. The tree's own og:image is deliberately untouched: the unfurl is the tree's
  // identity, this is a post the user makes.
  //
  // One card is cached, keyed by everything that can change it, because canon asks for the card to
  // be drawn BEFORE the sheet opens: the offer renders it while the toast is still up, and the
  // sheet's first frame is a cache hit rather than a hole where the post should be.
  const renderProgressCard = useCallback(async ({ lit, period, since, ledger }) => {
    if (!tree || !shareStats || !lit?.length) return null;
    const key = `${[...lit].sort().join(',')}|${period}|${since ?? ''}|${ledger ? ledger.join('·') : 'off'}`
      + `|${tree.title}|${shareStats.done}/${shareStats.total}`;
    if (cardCacheRef.current.key === key) return cardCacheRef.current.png;
    try {
      const model = tree.toRenderModel(layoutPositions(tree), states);
      // No dominant kind is passed: the card takes its hue from the steps that lit THIS period,
      // which is what keeps two consecutive posts from being the same picture.
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
      return null; // best-effort like every other share artifact — the sheet shows no preview, nothing breaks
    }
  }, [tree, states, shareStats, layoutPositions]);

  // What this period holds, and everything the sheet's second segment needs to post it. It is
  // derived, not stored: the offer and the share menu are two doors onto the SAME facts, and a
  // second copy of them behind the offer's door is how the two would eventually disagree.
  // Owner-and-editable, exactly like the milestone beat — a phone owner is who shares.
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
      onShared: () => recordShare(lit.length), // the card states its own stamp, so the ledger can never outrun it
    };
  }, [treeMine, shared, demo, demotion, tree, treeId, viewPrefs, completed, states, completedAt, renderProgressCard, recordShare]);

  // Taking the offer: draw the card, THEN open the sheet onto it — canon asks for a sheet that
  // opens onto the post, never onto a hole where the post will be. Accepting also clears the
  // decline count: someone who posts is not someone the offer should retire.
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

  // The offer's toast is built at the open that earned it and tapped a beat later, after `states`
  // and the tree have moved on. Going through the ref means the card draws the tree as it actually
  // stands when the sheet opens.
  openWeekSheetRef.current = openWeekSheet;
  // The milestone beat has always had the same stale-closure hazard, and it mattered more: its
  // toast could say "Tree complete — 22/22" while the card it published drew 21/22, because the
  // completion that earned the crown had not reached `states` in the render that built the action.
  publishOgImageRef.current = publishOgImage;

  // The week's offer (brief #20, reconciled to canon): the first open after a period closes,
  // riding the tail of the welcome-back recap. It is armed here and fired by the ceremony —
  // never mid-session, never on a timer, never twice in a period, and never for anyone but the
  // owner of an editable tree (the same gate the milestone beat uses: a phone owner is exactly
  // who posts). Two declines in a row and considerProgressShare stops answering, for good.
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
      // The ask is spent the moment it goes out, and counts as declined until taken. Every
      // surface that can make the offer now carries a standing Share door — the control bar
      // on desktop, the action lane's right slot below it (X8 §10) — so a toast left to fade
      // is a refusal everywhere, and retirement can never strand an owner.
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
