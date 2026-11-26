exports.run = function run(cmd) {
  return require("child_process").execSync(cmd);
};
