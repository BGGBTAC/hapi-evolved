import { expect, test } from 'bun:test'
import { requireRunnerAppArmor } from './sandbox'

test('requires the exact named enforce profile and explains missing host setup', () => {
    expect(() => requireRunnerAppArmor('docker-default (enforce)\nhapi-evolved-runner (enforce)\n')).not.toThrow()
    for (const value of ['', 'docker-default (enforce)', 'hapi-evolved-runner (complain)',
        'hapi-evolved-runner (unconfined)', 'other-hapi-evolved-runner (enforce)',
        'hapi-evolved-runner (enforce) suffix']) {
        expect(() => requireRunnerAppArmor(value)).toThrow('deploy/evolved/security/runner.apparmor')
    }
})
