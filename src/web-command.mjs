/** Only intentional user actions are recorded; polling and session traffic are excluded. */
export function webCommandEvent(method, args) {
  const [guildId, userId] = args;
  let command;
  let parameters;
  switch (method) {
    case 'search': command = 'search'; parameters = { query: args[2], source: args[3] }; break;
    case 'request': command = 'play'; parameters = { query: args[2], channelId: args[3] }; break;
    case 'join': command = 'join'; parameters = { channelId: args[2] }; break;
    case 'control': command = args[2]; parameters = { trackId: args[3] }; break;
    case 'setVolume': command = 'volume'; parameters = { volumePercent: args[2] }; break;
    case 'radio': command = args[2] === 'stop' ? 'radio-stop' : 'radio'; parameters = { query: args[3], channelId: args[4] }; break;
    default: return null;
  }
  return { source: 'web', guildId, userId, command, parameters };
}

export function runWebCommand(bot, method, args, operation) {
  const event = webCommandEvent(method, args);
  // The portal proxy does not expose auditCommand: the worker records the action
  // after validating its RPC arguments. Combined hosting records it locally.
  return event && bot.auditCommand ? bot.auditCommand(event, operation) : operation();
}
