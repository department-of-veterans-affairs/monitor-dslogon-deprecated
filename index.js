const puppeteer = require('puppeteer');
const performance = require('perf_hooks').performance;

const config = require('./src/config');
const listener = require('./src/page-listener');
// const validation = require('./src/validate');
// const statuspageio = require('./src/statuspage');

const authenticator = require('authenticator');

/**
 * Take a simple screenshot and store it in the local screenshot folder.
 * This is great for debugging.
 */
async function screenshot(page, filename) {
  if (filename == null && filename == '') {
    console.error(
      'filename is empty, screenshot must have a proper .png filename.'
    );
    return;
  }
  await page.screenshot({ path: `debug/${filename}` });
}

/**
 * Retry upon failure with a max timeout.
 *
 * @param {Func} fn Function to retry
 * @param {Time} ms Time in millis
 */
const retry = (fn, ms = 1000, maxRetries = 5) =>
  new Promise((resolve, reject) => {
    var retries = 0;
    fn()
      .then(resolve)
      .catch(() => {
        setTimeout(() => {
          console.log('retrying failed promise...');
          ++retries;
          if (retries == maxRetries) {
            return reject('maximum retries exceeded');
          }
          retry(fn, ms).then(resolve);
        }, ms);
      });
  });

/**
 * This is the heart of the monitoring system.
 * The path is va.gov -> id.me -> DSLogon (username, password) -> id.me (MFA) -> va.gov
 */
(async () => {
  const [
    url,
    username,
    password,
    mfaKey,
    slack,
    statuspage,
    debug
  ] = config.validateEnv();

  const dateTime = new Date().toISOString();

  // ignore HTTPS errors due to certificate errors
  const browser = await puppeteer.launch({
    ignoreHTTPSErrors: true,
    headless: true,
    slowMo: 100, // DSLogon website has been known to refresh the page if loaded too quickly, one way to counter it is to simulate human behavior of ~100ms.
    args: ['--start-fullscreen']
  });

  const start = performance.now();

  // setup a listener for unhandled promise rejections
  process.on('unhandledRejection', (reason, _p) => {
    const error = `an unhandled rejection at with reason: ${reason}`;
    console.error(error);

    // const endTime = performance.now();
    // const diffTimeInMs = endTime - start;

    // statuspageio(statuspage).postUpDownMetric(0);
    browser.close();
  });

  const pages = await browser.pages();
  let page = pages[0];
  listener.listen(page);

  console.log('Entering website now...');

  // set the initial login to high timeout, along with retry.
  page.setDefaultNavigationTimeout(60000);
  page.setViewport({ width: 1920, height: 900 });
  const REQ_TIMEOUT_MS = 2000;
  const MAX_RETRY = 5;
  const response = await retry(() => page.goto(url), REQ_TIMEOUT_MS, MAX_RETRY);

  // TODO: we should probably fail here and log it somewhere at failure
  console.log(`response: ${response.status()}`);

  // debug statement for getting to the website
  if (debug) {
    await screenshot(page, `${dateTime}-initial-website.png`);
  }
  console.log('Awaiting va.gov page pop-up rendering');
  await page.waitForSelector(
    '.va-modal-inner > .va-modal-body > div > div > button'
  );
  await page.click('.va-modal-inner > .va-modal-body > div > div > button');

  console.log('Awaiting va.gov navigation menu rendering');
  await page.waitForSelector('#mega-menu #vetnav-menu');
  await page.click('#mega-menu #vetnav-menu');

  console.log('Awaiting va.gov sign-in button rendering');
  await page.waitForSelector(
    '.profile-nav-container > .profile-nav > .sign-in-nav > .sign-in-links > .sign-in-link'
  );
  await page.click(
    '.profile-nav-container > .profile-nav > .sign-in-nav > .sign-in-links > .sign-in-link'
  );

  console.log('Awaiting va.gov DSLogon sign-in button rendering through ID.me');
  await page.waitForSelector(
    '.usa-width-one-half > .signin-actions-container > .signin-actions > div > .dslogon'
  );
  await page.click(
    '.usa-width-one-half > .signin-actions-container > .signin-actions > div > .dslogon'
  );

  // This doesn't quite work, so it is important we wait until the site successfully renders.
  console.log('Awaiting ID.me to redirect user to DSLogon primary site');
  await page.waitForNavigation({ waitUntil: 'networkidle0' });

  console.log('Awaiting DSLogon page to render the username/password fields');
  await page.waitForSelector(
    '#dslogon_content > .columnsContent > .formfield > label > #userName',
    { timeout: 60000 }
  );

  await page.click(
    '#dslogon_content > .columnsContent > .formfield > label > #userName'
  );

  await page.type(
    '#dslogon_content > .columnsContent > .formfield > label > #userName',
    username
  );

  await page.waitForSelector(
    '#dslogon_content > .columnsContent > .formfieldSmallGap > label[for=password-clear] > #password-clear',
    { timeout: 10000 }
  );

  await page.click(
    '#dslogon_content > .columnsContent > .formfieldSmallGap > label[for=password-clear] > #password-clear'
  );

  await page.type(
    '#dslogon_content > .columnsContent > .formfieldSmallGap > label[for=password-clear] > #password-clear',
    password
  );

  const dslogonStartTime = performance.now();
  console.log(
    'Completing DSLogon user authentication. Redirecting now to ID.me multifactor code.'
  );
  await page.waitForSelector(
    '.tab-content > #dslogon_content > #dslogon_content > .columnsContent > .formbuttons'
  );
  await page.click(
    '.tab-content > #dslogon_content > #dslogon_content > .columnsContent > .formbuttons'
  );
  const dslogonEndTimeMs = performance.now();
  const dslogonTotalTimeSec = (dslogonEndTimeMs - dslogonStartTime) / 1000;
  console.log(`Total DSLogon time ${dslogonTotalTimeSec}`);

  console.log('Awaiting multifactor code text field to render.');
  await page.waitForSelector(
    '.form-container > #new_multifactor #multifactor_code',
    { timeout: 10000 }
  );
  await page.click('.form-container > #new_multifactor #multifactor_code');
  await page.type(
    '.form-container > #new_multifactor #multifactor_code',
    authenticator.generateToken(mfaKey)
  );

  console.log(
    'Multifactor code entered. Awaiting the ID.me multifactor submission button to render'
  );
  await page.waitForSelector(
    '.form-container > #new_multifactor > .form-actions > .form-action-button > .btn'
  );
  await page.click(
    '.form-container > #new_multifactor > .form-actions > .form-action-button > .btn'
  );

  console.log('Redirecting to va.gov after successful submission of va.gov');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  console.log('Awaiting sign out button to render');
  await page.waitForSelector(
    '.profile-nav > .sign-in-nav > div > .va-dropdown > .va-btn-withicon'
  );
  await page.click(
    '.profile-nav > .sign-in-nav > div > .va-dropdown > .va-btn-withicon'
  );

  await page.waitForSelector(
    '.va-dropdown > #account-menu > ul > li:nth-child(5) > a'
  );
  await page.click('.va-dropdown > #account-menu > ul > li:nth-child(5) > a');
  await page.waitForNavigation({ waitUntil: 'networkidle0' });

  await browser.close();

  // Track the final timing of the application run
  // This is the user end-to-end experience for time from logging in to logging off.
  let end = performance.now();
  let timeInMs = end - start;

  console.log(
    `Completed web session. Notifying slack now.
  Took ${timeInMs / 1000} seconds.`
  );

  // // validate the HTML and notify the monitoring system
  // let errorText = validation.validateHtml(bodyHTML);
  // if (debug) {
  //   notifySlack(slack, errorText, timeInMs / 1000);
  // }

  // // send to statuspage.io
  // console.log('logging to statuspage.io');
  // let upOrDown = 0;
  // if (errorText === null) {
  //   upOrDown = 1;
  // }
  // statuspageio(statuspage).postMetrics(
  //   upOrDown,
  //   requestTimeMs,
  //   totalLogonTimeInMs,
  //   timeInMs
  // );
})();
