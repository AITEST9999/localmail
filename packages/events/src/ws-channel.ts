export function wsChannelForPod(podId: string): string {
  return `localmail:ws:${podId}`;
}
