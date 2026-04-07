/**
 * Centralized logging utility with timestamps.
 */
const formatLog = (msg, icon = '', label = '') => {
    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    const labelPart = label ? `[${label}] ` : '';
    const iconPart = icon ? `${icon} ` : '';
    return `[${time}] ${iconPart}${labelPart}${msg}`;
};

module.exports = {
    info: (msg, label = '', icon = 'ℹ️') => console.log(formatLog(msg, icon, label)),
    error: (msg, label = '', icon = '❌') => console.error(formatLog(msg, icon, label)),
    success: (msg, label = '', icon = '✅') => console.log(formatLog(msg, icon, label)),
    warn: (msg, label = '', icon = '⚠️') => console.warn(formatLog(msg, icon, label)),
    log: (msg, label = '', icon = '') => console.log(formatLog(msg, icon, label)),
};
