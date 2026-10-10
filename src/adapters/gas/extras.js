// Platform capabilities added by later feature modules (webhook envelope intake, mail/LINE providers,
// report rendering). Receives a lazy deps getter so providers are built only when used.
export function gasPlatformExtras(/* getDeps */) {
  return {};
}
