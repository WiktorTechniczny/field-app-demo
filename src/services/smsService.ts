/**
 * Service for sending SMS via smscenter.pl (Mobitex API)
 * 
 * IMPORTANT: To use this service, fill in the credentials below.
 * Note: Sending from frontend exposes credentials. Consider Supabase Edge Functions for production.
 */

// Replace with your smscenter.pl login
const SMS_USER = 'demoservices';

// Replace with MD5 hash of your password
const SMS_PASS_MD5 = 'PLACEHOLDER_MD5_PASSWORD';

// Replace with your approved Sender ID (Nadpis)
const SMS_FROM = 'INNE';

export async function sendSurveyConfirmationSms(phoneNumber: string, name: string) {
    if (SMS_PASS_MD5 === 'PLACEHOLDER_MD5_PASSWORD') {
        console.warn('SMS not sent: API credentials not configured.');
        return { success: false, error: 'Brak konfiguracji API' };
    }

    // Format number: remove plus, spaces, etc.
    const cleanNumber = phoneNumber.replace(/\D/g, '');
    
    // Ensure 48 prefix for Poland if not present and length is 9
    const targetNumber = (cleanNumber.length === 9) ? `48${cleanNumber}` : cleanNumber;

    const message = `Dziękujemy ${name} za wypełnienie ankiety. Twoje zgłoszenie zostało zarejestrowane. Pozdrawiamy, Zespół Demo.`;

    const params = new URLSearchParams({
        user: SMS_USER,
        pass: SMS_PASS_MD5,
        number: targetNumber,
        text: message,
        type: 'unicode', // Support Polish characters
        from: SMS_FROM
    });

    try {
        const response = await fetch(`https://api.mobitex.pl/sms.php?${params.toString()}`, {
            method: 'GET', // API supports both GET and POST, GET is simplest for this
        });

        const result = await response.text();
        
        // Response format is usually "Status: 0, ID: ..." for success
        if (result.startsWith('Status: 0')) {
            console.log('SMS sent successfully:', result);
            return { success: true, id: result.split('ID: ')[1] };
        } else {
            console.error('SMS sending failed:', result);
            return { success: false, error: result };
        }
    } catch (error) {
        console.error('SMS service error:', error);
        return { success: false, error: 'Błąd połączenia z API SMS' };
    }
}
