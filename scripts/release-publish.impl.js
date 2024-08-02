"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = runExecutor;
const devkit_1 = require("@nx/devkit");
const child_process_1 = require("child_process");
const npm_run_path_1 = require("npm-run-path");
const path_1 = require("path");
const npm_config_1 = require("../../utils/npm-config");
const log_tar_1 = require("./log-tar");
const chalk = require("chalk");
const extract_npm_publish_json_data_1 = require("./extract-npm-publish-json-data");
const LARGE_BUFFER = 1024 * 1000000;
function processEnv(color) {
  const env = {
    ...process.env,
    ...(0, npm_run_path_1.env)(),
  };
  if (color) {
    env.FORCE_COLOR = `${color}`;
  }
  return env;
}
async function runExecutor(options, context) {
  /**
   * We need to check both the env var and the option because the executor may have been triggered
   * indirectly via dependsOn, in which case the env var will be set, but the option will not.
   */
  const isDryRun = process.env.NX_DRY_RUN === 'true' || options.dryRun || false;
  const projectConfig = context.projectsConfigurations.projects[context.projectName];
  const packageRoot = (0, path_1.join)(context.root, options.packageRoot ?? projectConfig.root);
  const packageJsonPath = (0, path_1.join)(packageRoot, 'package.json');
  const packageJson = (0, devkit_1.readJsonFile)(packageJsonPath);
  const packageName = packageJson.name;
  // If package and project name match, we can make log messages terser
  let packageTxt = packageName === context.projectName
    ? `package "${packageName}"`
    : `package "${packageName}" from project "${context.projectName}"`;
  if (packageJson.private === true) {
    console.warn(`Skipped ${packageTxt}, because it has \`"private": true\` in ${packageJsonPath}`);
    return {
      success: true,
    };
  }
  const warnFn = (message) => {
    console.log(chalk.keyword('orange')(message));
  };
  const { registry, tag, registryConfigKey } = await (0, npm_config_1.parseRegistryOptions)(context.root, {
    packageRoot,
    packageJson,
  }, {
    registry: options.registry,
    tag: options.tag,
  }, warnFn);
  const npmViewCommandSegments = [
    `npm view ${packageName} versions dist-tags --json --"${registryConfigKey}=${registry}"`,
  ];
  const npmDistTagAddCommandSegments = [
    `npm dist-tag add ${packageName}@${packageJson.version} ${tag} --"${registryConfigKey}=${registry}"`,
  ];
  /**
   * In a dry-run scenario, it is most likely that all commands are being run with dry-run, therefore
   * the most up to date/relevant version might not exist on disk for us to read and make the npm view
   * request with.
   *
   * Therefore, so as to not produce misleading output in dry around dist-tags being altered, we do not
   * perform the npm view step, and just show npm publish's dry-run output.
   */
  if (!isDryRun && !options.firstRelease) {
    const currentVersion = packageJson.version;
    try {
      const result = (0, child_process_1.execSync)(npmViewCommandSegments.join(' '), {
        env: processEnv(true),
        cwd: context.root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const resultJson = JSON.parse(result.toString());
      const distTags = resultJson['dist-tags'] || {};
      if (distTags[tag] === currentVersion) {
        console.warn(`Skipped ${packageTxt} because v${currentVersion} already exists in ${registry} with tag "${tag}"`);
        return {
          success: true,
        };
      }
      // If only one version of a package exists in the registry, versions will be a string instead of an array.
      const versions = Array.isArray(resultJson.versions)
        ? resultJson.versions
        : [resultJson.versions];
      if (versions.includes(currentVersion)) {
        try {
          if (!isDryRun) {
            (0, child_process_1.execSync)(npmDistTagAddCommandSegments.join(' '), {
              env: processEnv(true),
              cwd: context.root,
              stdio: 'ignore',
            });
            console.log(`Added the dist-tag ${tag} to v${currentVersion} for registry ${registry}.\n`);
          }
          else {
            console.log(`Would add the dist-tag ${tag} to v${currentVersion} for registry ${registry}, but ${chalk.keyword('orange')('[dry-run]')} was set.\n`);
          }
          return {
            success: true,
          };
        }
        catch (err) {
          try {
            const stdoutData = JSON.parse(err.stdout?.toString() || '{}');
            // If the error is that the package doesn't exist, then we can ignore it because we will be publishing it for the first time in the next step
            if (!(stdoutData.error?.code?.includes('E404') &&
              stdoutData.error?.summary?.includes('no such package available')) &&
              !(err.stderr?.toString().includes('E404') &&
                err.stderr?.toString().includes('no such package available'))) {
              console.error('npm dist-tag add error:');
              if (stdoutData.error.summary) {
                console.error(stdoutData.error.summary);
              }
              if (stdoutData.error.detail) {
                console.error(stdoutData.error.detail);
              }
              if (context.isVerbose) {
                console.error('npm dist-tag add stdout:');
                console.error(JSON.stringify(stdoutData, null, 2));
              }
              return {
                success: false,
              };
            }
          }
          catch (err) {
            console.error('Something unexpected went wrong when processing the npm dist-tag add output\n', err);
            return {
              success: false,
            };
          }
        }
      }
    }
    catch (err) {
      const stdoutData = JSON.parse(err.stdout?.toString() || '{}');
      // If the error is that the package doesn't exist, then we can ignore it because we will be publishing it for the first time in the next step
      if (!(stdoutData.error?.code?.includes('E404') &&
        stdoutData.error?.summary?.toLowerCase().includes('not found')) &&
        !(err.stderr?.toString().includes('E404') &&
          err.stderr?.toString().toLowerCase().includes('not found'))) {
        console.error(`Something unexpected went wrong when checking for existing dist-tags.\n`, err);
        return {
          success: false,
        };
      }
    }
  }
  if (options.firstRelease && context.isVerbose) {
    console.log('Skipped npm view because --first-release was set');
  }
  /**
   * NOTE: If this is ever changed away from running the command at the workspace root and pointing at the package root (e.g. back
   * to running from the package root directly), then special attention should be paid to the fact that npm publish will nest its
   * JSON output under the name of the package in that case (and it would need to be handled below).
   */
  const npmPublishCommandSegments = [
    `npm publish "${packageRoot}" --json --"${registryConfigKey}=${registry}" --tag=${tag}`,
  ];
  if (options.otp) {
    npmPublishCommandSegments.push(`--otp=${options.otp}`);
  }
  if (isDryRun) {
    npmPublishCommandSegments.push(`--dry-run`);
  }
  try {
    const output = (0, child_process_1.execSync)(npmPublishCommandSegments.join(' '), {
      maxBuffer: LARGE_BUFFER,
      env: processEnv(true),
      cwd: context.root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(output)
    /**
     * We cannot JSON.parse the output directly because if the user is using lifecycle scripts, npm will mix its publish output with the JSON output all on stdout.
     * Additionally, we want to capture and show the lifecycle script outputs as beforeJsonData and afterJsonData and print them accordingly below.
     */
    const { beforeJsonData, jsonData, afterJsonData } = (0, extract_npm_publish_json_data_1.extractNpmPublishJsonData)(output.toString());
    if (!jsonData) {
      console.error('The npm publish output data could not be extracted. Please report this issue on https://github.com/nrwl/nx');
      return {
        success: false,
      };
    }
    // If in dry-run mode, the version on disk will not represent the version that would be published, so we scrub it from the output to avoid confusion.
    const dryRunVersionPlaceholder = 'X.X.X-dry-run';
    if (isDryRun) {
      for (const [key, val] of Object.entries(jsonData)) {
        if (typeof val !== 'string') {
          continue;
        }
        jsonData[key] = val.replace(new RegExp(packageJson.version, 'g'), dryRunVersionPlaceholder);
      }
    }
    if (typeof beforeJsonData === 'string' &&
      beforeJsonData.trim().length > 0) {
      console.log(beforeJsonData);
    }
    (0, log_tar_1.logTar)(jsonData);
    if (typeof afterJsonData === 'string' && afterJsonData.trim().length > 0) {
      console.log(afterJsonData);
    }
    if (isDryRun) {
      console.log(`Would publish to ${registry} with tag "${tag}", but ${chalk.keyword('orange')('[dry-run]')} was set`);
    }
    else {
      console.log(`Published to ${registry} with tag "${tag}"`);
    }
    return {
      success: true,
    };
  }
  catch (err) {
    try {
      const stdoutData = JSON.parse(err.stdout?.toString() || '{}');
      console.error('npm publish error:');
      if (stdoutData.error?.summary) {
        console.error(stdoutData.error.summary);
      }
      if (stdoutData.error?.detail) {
        console.error(stdoutData.error.detail);
      }
      if (context.isVerbose) {
        console.error('npm publish stdout:');
        console.error(JSON.stringify(stdoutData, null, 2));
      }
      if (!stdoutData.error) {
        throw err;
      }
      return {
        success: false,
      };
    }
    catch (err) {
      console.error('Something unexpected went wrong when processing the npm publish output\n', err);
      return {
        success: false,
      };
    }
  }
}
