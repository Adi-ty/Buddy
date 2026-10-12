export const requests = []
export function execFile(path, args, options, callback) {
  requests.push({ path, args, options, callback })
}
