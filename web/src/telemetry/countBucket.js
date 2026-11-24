// A count as the bounded label an event carries (`0/1/2-5/6-20/21+`), never the count itself. Its own module, so a
// test that stands in for the beacon keeps the buckets real.
export function countBucket(n) {
  if (n < 1) return '0';
  if (n === 1) return '1';
  if (n <= 5) return '2-5';
  if (n <= 20) return '6-20';
  return '21+';
}
